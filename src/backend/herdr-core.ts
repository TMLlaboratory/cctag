import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { AgentDriver } from "../agents/driver.js";
import { HC_CODEX_UNBOUND_NOTICE, HC_CODEX_WRITE_NOTICE } from "../agents/codex/driver.js";
import { inspectHcCodexPrompt } from "../agents/codex/prompts.js";
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
const ANSWER_PANE_LINES = 200;
const CLAUDE_APP = "claude-code";
export const HC_TYPED_TEXT_UNSUPPORTED =
  "herdr-core では、文字を入力したまま送信せずに次の操作へ進めないため、この回答は送れません。端末で答えてください。";
export const HC_UNSUPPORTED_AGENTS_NOTICE =
  "herdr-core 上の omp などのエージェントには、まだ接続できません。";

/** What `hc get --json` returns; only the fields cctag reads. */
interface HcTerminal {
  address: string;
  name?: string | null;
  state: string;
  turn?: number;
  title?: string | null;
  foreground?: { pid?: number; cwd?: string; name?: string } | null;
  status?: { app?: string | null; state?: string | null; kind?: string | null } | null;
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

function probeSocket(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ path });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(2_000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** Claude Code writes `~/.claude/sessions/<pid>.json` with the session id and the cwd its transcript is filed under. */
async function claudeSession(pid: number, sessionsDir: string): Promise<{ sessionId: string; cwd: string } | null> {
  try {
    const raw = JSON.parse(await readFile(join(sessionsDir, `${pid}.json`), "utf8")) as { sessionId?: unknown; cwd?: unknown };
    if (typeof raw.sessionId !== "string" || typeof raw.cwd !== "string") return null;
    return { sessionId: raw.sessionId, cwd: raw.cwd };
  } catch {
    return null;
  }
}

function normalizeStatus(raw: string | null | undefined): AgentStatus {
  return raw && KNOWN_STATUSES.has(raw as AgentStatus) ? (raw as AgentStatus) : "unknown";
}

function isCodex(terminal: HcTerminal): boolean {
  return terminal.status?.app === "codex" || basename(terminal.foreground?.name ?? "") === "codex";
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
  private async raw(args: string[]): Promise<string> {
    if (!(await probeSocket(this.socket))) {
      throw new BackendUnavailable(`herdr-core is not running (nothing listens on ${this.socket}); cctag does not start it`);
    }
    const env = { ...process.env };
    delete env.HC_TERMINAL_ID;
    delete env.HC_SCOPE;
    delete env.HC_TERMINAL_SOCKET;
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
  private async json<T>(command: string[], operands: string[] = []): Promise<T> {
    const stdout = await this.raw([...command, "--json", "--", ...operands]);
    try {
      return JSON.parse(stdout) as T;
    } catch {
      throw new BackendUnavailable(`hc ${command[0]} returned non-JSON output`);
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
    const pid = terminal.foreground?.pid;
    if (terminal.state !== "live") return null;
    if (isCodex(terminal)) {
      // A writer may still own the previous rollout after /new.
      const status = normalizeStatus(terminal.status?.state);
      return {
        ref: { target: `${PREFIX}${terminal.address}`, pid: null, processStartedAt: null, agentKind: "codex" },
        backend: "herdr-core",
        agent: "codex",
        sessionId: null,
        // hc's top-level cwd only records where the terminal was created.
        cwd: terminal.foreground?.cwd ?? "",
        evidence: { kind: "classified", status },
        turn: terminal.turn,
        terminalTitle: null,
        terminalId: terminal.address,
        displayId: terminal.name ?? terminal.address,
      };
    }
    if (typeof pid !== "number") return null;
    const session = await claudeSession(pid, this.sessionsDir);
    if (!session) return null;
    return {
      ref: { target: `${PREFIX}${terminal.address}`, pid: null, processStartedAt: null },
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
      listed = (await this.json<{ terminals?: HcListedTerminal[] }>(["ls"])).terminals ?? [];
    } catch (err) {
      return { agents: [], failures: [{ backend: "herdr-core", reason: errorMessage(err) }], complete: false, notices: [] };
    }
    // Remote machines' terminals (`machine/t7`) belong to the Spoke on that machine.
    const local = listed.filter((t) => t.state === "live" && !t.address.includes("/"));
    const notices: string[] = [];
    if (local.some((t) => t.agent !== CLAUDE_APP && t.agent !== "codex" && t.status !== undefined)) {
      notices.push(HC_UNSUPPORTED_AGENTS_NOTICE);
    }
    const failures: ListResult["failures"] = [];
    const discovered = await Promise.all(
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
    );
    if (local.some((t) => t.agent === "codex") || discovered.some((a) => a?.agent === "codex")) {
      notices.push(HC_CODEX_UNBOUND_NOTICE);
    }
    const agents = discovered.filter((agent): agent is AgentInfo => agent?.agent === "claude");
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
    const address = addressOf(target);
    const before = await this.terminal(address);
    const result = await this.json<{ text?: string; complete?: boolean }>(
      before && isCodex(before) ? ["read"] : command,
      [address],
    );
    const after = await this.terminal(address);
    const snapshot = { text: result.text ?? "", draft: null, complete: result.complete === true };
    const beforeCodex = before && isCodex(before);
    const afterCodex = after && isCodex(after);
    if (beforeCodex || afterCodex) {
      const status = after?.status;
      const kind = status?.kind;
      const stable = beforeCodex && afterCodex &&
        typeof before.foreground?.pid === "number" && before.foreground.pid === after.foreground?.pid &&
        before.status?.state === status?.state && before.status?.kind === kind;
      const prompt = !stable ? null : status?.state === "blocked"
        ? (kind === "question" || kind === "permission" ? inspectHcCodexPrompt(snapshot, kind) : null)
        : inspectHcCodexPrompt(snapshot);
      return { text: "", draft: null, complete: false, ...(prompt ? { observedPrompt: prompt } : {}) };
    }
    return { ...snapshot, text: stripSidePane(snapshot.text) };
  }

  private async assertWritable(ref: AgentRef, driver: AgentDriver): Promise<void> {
    const refused = () => new ExpectationLost(HC_CODEX_WRITE_NOTICE, HC_CODEX_WRITE_NOTICE);
    if (ref.agentKind === "codex" || driver?.kind === "codex") throw refused();
    const terminal = await this.terminal(addressOf(ref.target));
    if (!terminal || terminal.state !== "live" || isCodex(terminal)) throw refused();
  }

  async submit(ref: AgentRef, text: string, ctx: SubmitContext): Promise<SubmitOutcome> {
    let result: { started?: boolean };
    try {
      await this.assertWritable(ref, ctx.driver);
    } catch (err) {
      if (err instanceof ExpectationLost) throw new SubmitRefused("gate", err.message);
      throw err;
    }
    try {
      result = await this.json<{ started?: boolean }>(["send"], [addressOf(ref.target), text]);
    } catch (err) {
      if (err instanceof HcCliError && err.kind === "blocked") {
        throw new SubmitRefused("gate", `herdr-core refused the send: ${err.message}`);
      }
      throw new WriteOutcomeUnknown(err);
    }
    // `started` is whether the agent began a turn; a slash command such as /model never does.
    return { status: result.started === true ? "started" : "accepted", draftStashed: false };
  }

  openAnswer(ref: AgentRef, prompt: VerifiedPrompt): AnswerChannel {
    const channel = this.createAnswerChannel(ref, prompt);
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
  private createAnswerChannel(ref: AgentRef, prompt: VerifiedPrompt): ModelAnswerChannel {
    const address = addressOf(ref.target);
    let firstWrite = true;
    let active = true;
    let pendingText: string | null = null;
    const assertFingerprint = async (): Promise<void> => {
      const snapshot = await this.read(ref.target, ANSWER_PANE_LINES, prompt.driver.readRegion);
      const current = prompt.driver.parseBlockedPane(snapshot.text);
      if ((current.kind !== "question" && current.kind !== "permission") || current.verified.fingerprint !== prompt.fingerprint) {
        throw new ExpectationLost("the verified prompt is no longer on screen");
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
    const write = async (action: () => Promise<void>, terminal = false): Promise<void> => {
      assertActive();
      await this.assertWritable(ref, prompt.driver);
      if (firstWrite) await assertFingerprint();
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
        return write(keys(String(n)), terminal);
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

  openBlind(ref: AgentRef, prompt: BlindPermissionPrompt): BlindChannel {
    const address = addressOf(ref.target);
    return {
      answer: async (choice) => {
        await this.assertWritable(ref, prompt.driver);
        await this.json(["keys"], [address, choice]);
        if (prompt.form === "key-confirms") return;
        await this.assertWritable(ref, prompt.driver);
        await this.json(["keys"], [address, "enter"]);
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
