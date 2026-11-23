import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { isClaudeModelSwitchConfirmation } from "../agents/claude/driver.js";
import type { AgentDriver } from "../agents/driver.js";
import type {
  AnswerChannel,
  BlindChannel,
  ComposerChannel,
  ModelAnswerChannel,
  SubmitContext,
  SubmitOutcome,
  Terminals,
} from "./index.js";
import type { BlindPermissionPrompt, VerifiedModelMenuPrompt, VerifiedPrompt } from "./prompt.js";
import { stripSidePane } from "./side-pane.js";
import { backendForTarget } from "./target.js";
import {
  BackendUnavailable,
  CoreNotRunning,
  ExpectationLost,
  SubmitRefused,
  UnknownTarget,
  WriteOutcomeUnknown,
  type AgentInfo,
  type AgentRef,
  type AgentStatus,
  type ListResult,
  type ScreenSnapshot,
} from "./types.js";

const execFileAsync = promisify(execFile);
const PREFIX = "hc:";
const KNOWN_STATUSES = new Set<AgentStatus>(["idle", "working", "blocked", "done"]);
const CLAUDE_APP = "claude-code";
const HC_CLAUDE_UNVERIFIED = "herdr-core の前景で Claude Code を確認できませんでした。端末の状態を確認してください。";
const HC_CLAUDE_CHANGED = "herdr-core の Claude Code セッションが切り替わりました。端末の状態を確認してください。";
const HC_BLOCKED_CHANGED = "herdr-core の入力待ち状態が変わりました。端末の状態を確認してください。";
export const HC_TYPED_TEXT_UNSUPPORTED =
  "herdr-core では、文字を入力したまま送信せずに次の操作へ進めないため、この回答は送れません。端末で答えてください。";
export const HC_UNSUPPORTED_AGENTS_NOTICE =
  "herdr-core 上の Claude Code 以外のエージェント（Codex・omp など）には、まだ接続できません。";

/** What `hc get --json` returns; only the fields cctag reads. */
interface HcTerminal {
  address: string;
  name?: string | null;
  cwd: string;
  state: string;
  title?: string | null;
  foreground?: { pid?: number; cwd?: string; name?: string } | null;
  status?: { app?: string | null; state?: string | null } | null;
}

/** What `hc ls --json` returns per terminal. */
interface HcListedTerminal {
  address: string;
  agent?: string;
  state: string;
  /** Present only for programs that report their state (coding agents), absent for shells. */
  status?: string;
}

class HcCliError extends Error {
  constructor(
    readonly kind: string,
    message: string,
  ) {
    super(message);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function addressOf(target: string): string {
  if (backendForTarget(target) !== "herdr-core") throw new UnknownTarget(`not a herdr-core target: ${target}`);
  return target.slice(PREFIX.length);
}

/**
 * The core socket the Spoke may talk to.
 * shortcut: assumes the default hc session and state directory; honour HC_SESSION / XDG paths when someone runs a non-default core.
 */
export function defaultHcSocket(env: NodeJS.ProcessEnv = process.env): string {
  return env.HC_SOCKET || join(homedir(), ".local", "state", "herdr-core", "default", "default.sock");
}

function probeSocket(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path });
    socket.setTimeout(2_000, () => {
      socket.destroy();
      reject(new BackendUnavailable(`herdr-core socket probe timed out: ${path}`));
    });
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.once("error", (err: NodeJS.ErrnoException) => {
      reject(err.code === "ENOENT" || err.code === "ECONNREFUSED"
        ? new CoreNotRunning(`herdr-core is not running (nothing listens on ${path}); cctag does not start it`)
        : new BackendUnavailable(err.message));
    });
  });
}

/** Claude Code writes `~/.claude/sessions/<pid>.json` with the session id and the cwd its transcript is filed under. */
async function claudeSession(pid: number, sessionsDir: string): Promise<{ sessionId: string; cwd: string; startedAt: number | null } | null> {
  try {
    const raw = JSON.parse(await readFile(join(sessionsDir, `${pid}.json`), "utf8")) as {
      pid?: unknown; sessionId?: unknown; cwd?: unknown; startedAt?: unknown;
    };
    if (typeof raw.sessionId !== "string" || !raw.sessionId || typeof raw.cwd !== "string") return null;
    if (raw.pid !== undefined && raw.pid !== pid) return null;
    const startedAt = raw.pid === pid && typeof raw.startedAt === "number" &&
      Number.isSafeInteger(raw.startedAt) && raw.startedAt > 0 ? raw.startedAt : null;
    return { sessionId: raw.sessionId, cwd: raw.cwd, startedAt };
  } catch {
    return null;
  }
}

function normalizeStatus(raw: string | null | undefined): AgentStatus {
  return raw && KNOWN_STATUSES.has(raw as AgentStatus) ? (raw as AgentStatus) : "unknown";
}

function claudeForegroundPid(terminal: HcTerminal): number | null {
  const { pid, name } = terminal.foreground ?? {};
  const executable = typeof name === "string" ? basename(name) : "";
  return terminal.state === "live" && typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 &&
    (executable === "claude" || executable === CLAUDE_APP) &&
    (terminal.status?.app == null || terminal.status.app === CLAUDE_APP) ? pid : null;
}

export interface HcBackendOptions {
  socket?: string;
  sessionsDir?: string;
}

export class HcBackend implements Terminals {
  private readonly socket: string;
  private readonly sessionsDir: string;

  constructor(
    private readonly bin: string,
    options: HcBackendOptions = {},
  ) {
    this.socket = options.socket ?? defaultHcSocket();
    this.sessionsDir = options.sessionsDir ?? join(homedir(), ".claude", "sessions");
  }

  /**
   * Runs `hc` and returns its stdout.
   *
   * Two things are deliberate. The core is probed first because any hc command
   * starts a stopped core, and a core started by the Spoke hands the Spoke's
   * environment to every terminal. And HC_TERMINAL_ID / HC_SCOPE are dropped so
   * a Spoke run inside an hc terminal does not get its sends wrapped in
   * `<hc from=…>`, which also stops slash commands from working.
   */
  private async raw(args: string[], cancelled?: () => boolean): Promise<string> {
    await probeSocket(this.socket);
    const env: NodeJS.ProcessEnv = { ...process.env, HC_SOCKET: this.socket };
    delete env.HC_TERMINAL_ID;
    delete env.HC_SCOPE;
    delete env.HC_TERMINAL_SOCKET;
    if (cancelled?.()) throw new SubmitRefused("cancelled", "herdr-core submit was cancelled before writing");
    try {
      const result = await execFileAsync(this.bin, args, { env, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
      return result.stdout;
    } catch (err) {
      const error = err as { message?: string; stderr?: string };
      try {
        const parsed = JSON.parse(error.stderr ?? "") as { error?: { kind?: string; message?: string } };
        if (parsed.error?.kind) throw new HcCliError(parsed.error.kind, parsed.error.message ?? parsed.error.kind);
      } catch (parseErr) {
        if (parseErr instanceof HcCliError) throw parseErr;
      }
      throw new BackendUnavailable(error.message ?? "hc command failed");
    }
  }

  /**
   * Runs `hc <command> --json -- <operands>`. The `--` keeps a message that
   * starts with `-` (a Slack reply such as "-1" or "--force") an operand
   * instead of a flag.
   */
  private async json<T>(command: string[], operands: string[] = [], cancelled?: () => boolean): Promise<T> {
    const stdout = await this.raw([...command, "--json", "--", ...operands], cancelled);
    try {
      return JSON.parse(stdout) as T;
    } catch {
      throw new BackendUnavailable(`hc returned non-JSON output: ${stdout.slice(0, 200)}`);
    }
  }

  private async terminal(address: string): Promise<HcTerminal | null> {
    try {
      return await this.json<HcTerminal>(["get"], [address]);
    } catch (err) {
      if (err instanceof HcCliError && err.kind === "not_found") return null;
      if (err instanceof BackendUnavailable) throw err;
      throw new BackendUnavailable(errorMessage(err));
    }
  }

  private async agentFrom(terminal: HcTerminal): Promise<AgentInfo | null> {
    const pid = claudeForegroundPid(terminal);
    if (pid === null) return null;
    const session = await claudeSession(pid, this.sessionsDir);
    if (!session) return null;
    return {
      ref: { target: `${PREFIX}${terminal.address}`, pid, processStartedAt: session.startedAt, sessionId: session.sessionId },
      backend: "herdr-core",
      agent: "claude",
      sessionId: session.sessionId,
      cwd: session.cwd,
      evidence: { kind: "classified", status: normalizeStatus(terminal.status?.state) },
      terminalTitle: terminal.title?.trim() || null,
      terminalId: terminal.address,
      displayId: terminal.name ?? terminal.address,
    };
  }

  async list(): Promise<ListResult> {
    let listed: HcListedTerminal[];
    try {
      listed = (await this.json<{ terminals: HcListedTerminal[] }>(["ls"])).terminals;
      if (!Array.isArray(listed)) throw new BackendUnavailable("hc ls did not return a terminal list");
    } catch (err) {
      if (err instanceof CoreNotRunning) throw err;
      return { agents: [], failures: [{ backend: "herdr-core", reason: errorMessage(err) }], complete: false, notices: [] };
    }
    // Remote machines' terminals (`machine/t7`) belong to the Spoke on that machine.
    const local = listed.filter((t) => t.state === "live" && !t.address.includes("/"));
    const notices = local.some((t) => t.agent !== CLAUDE_APP && t.status !== undefined) ? [HC_UNSUPPORTED_AGENTS_NOTICE] : [];
    const failures: ListResult["failures"] = [];
    const agents = (
      await Promise.all(
        local
          .filter((t) => t.agent === CLAUDE_APP)
          .map(async (t) => {
            try {
              const terminal = await this.terminal(t.address);
              return terminal ? await this.agentFrom(terminal) : null;
            } catch (err) {
              failures.push({ backend: "herdr-core", reason: `${t.address}: ${errorMessage(err)}` });
              return null;
            }
          }),
      )
    ).filter((agent): agent is AgentInfo => agent !== null);
    return { agents, failures, complete: failures.length === 0, notices };
  }

  async get(target: string): Promise<AgentInfo | null> {
    const terminal = await this.terminal(addressOf(target));
    return terminal ? this.agentFrom(terminal) : null;
  }

  async exists(target: string): Promise<boolean> {
    const terminal = await this.terminal(addressOf(target));
    return terminal !== null && terminal.state === "live";
  }

  async read(target: string, lines: number, region: "screen" | "history"): Promise<ScreenSnapshot> {
    const command = region === "history" && lines > 0 ? ["read", "--lines", String(lines)] : ["read"];
    const result = await this.json<{ text?: string; complete?: boolean }>(command, [addressOf(target)]);
    return { text: stripSidePane(result.text ?? ""), draft: null, complete: result.complete === true };
  }

  private async assertWritable(ref: AgentRef, driver: AgentDriver): Promise<HcTerminal> {
    const address = addressOf(ref.target);
    const terminal = await this.terminal(address);
    const pid = terminal ? claudeForegroundPid(terminal) : null;
    if (driver.kind !== "claude" || terminal?.address !== address || pid === null ||
        ref.pid === null || ref.processStartedAt === null || !ref.sessionId) {
      throw new ExpectationLost(HC_CLAUDE_UNVERIFIED, HC_CLAUDE_UNVERIFIED);
    }
    if (pid !== ref.pid) throw new ExpectationLost(HC_CLAUDE_CHANGED, HC_CLAUDE_CHANGED);
    const session = await claudeSession(pid, this.sessionsDir);
    if (session?.startedAt == null) throw new ExpectationLost(HC_CLAUDE_UNVERIFIED, HC_CLAUDE_UNVERIFIED);
    if (session.sessionId !== ref.sessionId || session.startedAt !== ref.processStartedAt) {
      throw new ExpectationLost(HC_CLAUDE_CHANGED, HC_CLAUDE_CHANGED);
    }
    return terminal;
  }

  async submit(ref: AgentRef, text: string, ctx: SubmitContext): Promise<SubmitOutcome> {
    try {
      await this.assertWritable(ref, ctx.driver);
    } catch (err) {
      if (err instanceof ExpectationLost) throw new SubmitRefused("agent-unverified", err.message);
      throw err;
    }
    let result: { started?: boolean };
    try {
      result = await this.json<{ started?: boolean }>(["send"], [addressOf(ref.target), text], () => ctx.cancelled());
    } catch (err) {
      if (err instanceof SubmitRefused) throw err;
      if (err instanceof HcCliError && err.kind === "blocked") {
        throw new SubmitRefused("gate", `herdr-core refused the send: ${err.message}`);
      }
      throw new WriteOutcomeUnknown(err);
    }
    // `started` is whether the agent began a turn; a slash command such as /model never does.
    return { status: result.started === true ? "started" : "accepted", draftStashed: false };
  }

  openAnswer(ref: AgentRef, prompt: VerifiedPrompt, purpose?: "claude-model-switch"): AnswerChannel {
    const channel = this.createAnswerChannel(ref, prompt, purpose === "claude-model-switch");
    return { digit: channel.digit, text: channel.text, move: channel.move, complete: channel.complete, confirm: channel.confirm };
  }

  openModelAnswer(ref: AgentRef, prompt: VerifiedModelMenuPrompt): ModelAnswerChannel {
    if (prompt.capability !== "codex-model-menu" || prompt.driver.kind !== "codex" || prompt.form !== "digit-then-enter") {
      throw new ExpectationLost("Escape is restricted to verified Codex model-selection menus");
    }
    return this.createAnswerChannel(ref, prompt);
  }

  /**
   * hc has no way to type text without pressing Enter (`hc keys` takes key
   * names only), so `text()` holds the value and the following `confirm()`
   * pastes it with Enter through `hc send --force`. Anything else after
   * `text()` would need the text typed but not submitted, and is refused.
   */
  private createAnswerChannel(ref: AgentRef, prompt: VerifiedPrompt, modelSwitch = false): ModelAnswerChannel {
    const address = addressOf(ref.target);
    let firstWrite = true;
    let active = true;
    let answerStatus: "blocked" | "done" = "blocked";
    let pendingText: string | null = null;
    const assertFingerprint = async (modelConfirmation: boolean): Promise<void> => {
      const before = await this.assertWritable(ref, prompt.driver);
      answerStatus = modelConfirmation && before.status?.state === "done" ? "done" : "blocked";
      if (before.status?.state !== answerStatus) throw new ExpectationLost(HC_BLOCKED_CHANGED, HC_BLOCKED_CHANGED);
      const snapshot = await this.read(ref.target, 0, "screen");
      if (!snapshot.complete) throw new ExpectationLost("the verified prompt screen is incomplete");
      const current = prompt.driver.parseBlockedPane(snapshot.text);
      if ((current.kind !== "question" && current.kind !== "permission") || current.verified.fingerprint !== prompt.fingerprint) {
        throw new ExpectationLost("the verified prompt is no longer on screen");
      }
      if (modelConfirmation && !isClaudeModelSwitchConfirmation(current)) {
        throw new ExpectationLost(HC_BLOCKED_CHANGED, HC_BLOCKED_CHANGED);
      }
    };
    const assertActive = (): void => {
      if (!active) throw new ExpectationLost("the answer channel is already complete");
    };
    const assertNoPendingText = (): void => {
      if (pendingText !== null) {
        throw new ExpectationLost("herdr-core cannot type text without submitting it", HC_TYPED_TEXT_UNSUPPORTED);
      }
    };
    const write = async (action: () => Promise<void>, terminal = false, modelConfirmation = false): Promise<void> => {
      assertActive();
      if (modelSwitch && !modelConfirmation) throw new ExpectationLost("only the affirmative model-switch digit is allowed");
      if (firstWrite) await assertFingerprint(modelConfirmation);
      const current = await this.assertWritable(ref, prompt.driver);
      if (current.status?.state !== answerStatus) throw new ExpectationLost(HC_BLOCKED_CHANGED, HC_BLOCKED_CHANGED);
      await action();
      firstWrite = false;
      if (terminal) active = false;
    };
    const keys = (...names: string[]) => async () => {
      await this.json(["keys"], [address, ...names]);
    };

    return {
      digit: (n, terminal = prompt.form === "digit-confirms") => {
        assertNoPendingText();
        return write(keys(String(n)), terminal, modelSwitch && n === 1 && terminal);
      },
      text: async (value) => {
        assertActive();
        assertNoPendingText();
        pendingText = value;
      },
      move: async (direction, count) => {
        assertActive();
        assertNoPendingText();
        if (count <= 0) return;
        await write(keys(...Array(count).fill(direction === "Up" ? "up" : "down")));
      },
      confirm: (_expectedLabel, terminal = true) => {
        const text = pendingText;
        pendingText = null;
        if (text === null) return write(keys("enter"), terminal);
        return write(async () => {
          await this.json(["send", "--force"], [address, text]);
        }, terminal);
      },
      complete: () => {
        assertActive();
        assertNoPendingText();
        if (firstWrite) throw new ExpectationLost("an answer channel cannot complete before its first write");
        active = false;
      },
      escape: () => {
        assertNoPendingText();
        return write(keys("esc"), true);
      },
    };
  }

  openBlind(_ref: AgentRef, _prompt: BlindPermissionPrompt): BlindChannel {
    return {
      answer: async () => {
        throw new ExpectationLost("herdr-core cannot verify the permission prompt", "許可リクエストを確認できませんでした。ターミナルで回答してください。");
      },
    };
  }

  openComposer(ref: AgentRef, driver: AgentDriver): ComposerChannel {
    const address = addressOf(ref.target);
    return {
      backTab: async () => {
        await this.assertWritable(ref, driver);
        await this.json(["keys"], [address, "shift+tab"]);
      },
    };
  }
}
