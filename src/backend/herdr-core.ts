import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { AgentDriver } from "../agents/driver.js";
import { HC_CODEX_UNBOUND_NOTICE, HC_CODEX_WRITE_NOTICE } from "../agents/codex/driver.js";
import { inspectHcCodexPrompt, isHcCodexTrustPrompt } from "../agents/codex/prompts.js";
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
const CLAUDE_APP = "claude-code";
const HC_CLAUDE_UNVERIFIED = "herdr-core の前景で Claude Code を確認できませんでした。端末の状態を確認してください。";
const HC_CLAUDE_CHANGED = "herdr-core の Claude Code セッションが切り替わりました。端末の状態を確認してください。";
const HC_BLOCKED_CHANGED = "herdr-core の入力待ち状態が変わりました。端末の状態を確認してください。";
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
  status?: string | null;
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

function isCodex(terminal: HcTerminal): boolean {
  return terminal.status?.app === "codex" || basename(terminal.foreground?.name ?? "") === "codex";
}

function claudeForegroundPid(terminal: HcTerminal): number | null {
  const { pid, name } = terminal.foreground ?? {};
  const executable = basename(name ?? "");
  return terminal.state === "live" && typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 &&
    (executable === "claude" || executable === CLAUDE_APP) &&
    (terminal.status == null || terminal.status.app === CLAUDE_APP) ? pid : null;
}

export interface HcBackendOptions {
  socket?: string;
  sessionsDir?: string;
}

export class HcBackend implements Terminals {
  private readonly socket: string;
  private readonly sessionsDir: string;
  private readonly claudeReads = new Map<string, { agent?: WeakRef<AgentInfo> }>();

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
    const env: NodeJS.ProcessEnv = { ...process.env, HC_SOCKET: this.socket };
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
      const status = terminal.status?.app === "codex" ? normalizeStatus(terminal.status.state) : "unknown";
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
      ref: {
        target: `${PREFIX}${terminal.address}`,
        pid: claudeForegroundPid(terminal),
        processStartedAt: session.startedAt,
        sessionId: session.sessionId,
      },
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
    if (local.some((t) => t.agent !== CLAUDE_APP && t.agent !== "codex" && t.status != null)) {
      notices.push(HC_UNSUPPORTED_AGENTS_NOTICE);
    }
    let omittedCodex = local.some((t) => t.agent === "codex");
    const failures: ListResult["failures"] = [];
    const discovered = await Promise.all(
      local
        .filter((t) => t.agent === CLAUDE_APP || (t.agent !== "codex" && t.status == null))
        .map(async (t) => {
          try {
            const terminal = await this.terminal(t.address);
            if (terminal?.state !== "live") return null;
            if (isCodex(terminal)) {
              omittedCodex = true;
              return null;
            }
            return t.agent === CLAUDE_APP ? await this.agentFrom(terminal) : null;
          } catch (err) {
            // Status-less non-Claude candidates are probed only for the Codex picker notice.
            if (t.agent === CLAUDE_APP) {
              failures.push({ backend: "herdr-core", reason: `${t.address}: ${errorMessage(err)}` });
            }
            return null;
          }
        }),
    );
    if (omittedCodex) notices.push(HC_CODEX_UNBOUND_NOTICE);
    const agents = discovered.filter((agent): agent is AgentInfo => agent !== null);
    return { agents, failures, complete: failures.length === 0, notices };
  }

  async get(target: string): Promise<AgentInfo | null> {
    const address = addressOf(target);
    const observation: { agent?: WeakRef<AgentInfo> } = {};
    this.claudeReads.set(target, observation);
    try {
      const terminal = await this.terminal(address);
      if (!terminal) return null;
      const agent = await this.agentFrom(terminal);
      if (agent?.agent === "claude" && agent.ref.pid !== null && terminal.status?.app === CLAUDE_APP) {
        observation.agent = new WeakRef(agent);
      }
      return agent;
    } finally {
      if (!observation.agent && this.claudeReads.get(target) === observation) this.claudeReads.delete(target);
    }
  }

  async exists(target: string): Promise<boolean> {
    const terminal = await this.terminal(addressOf(target));
    return terminal !== null && terminal.state === "live";
  }

  private async capture(address: string): Promise<ScreenSnapshot> {
    // A positive --lines can make hc scroll a full-screen app.
    const result = await this.json<{ text?: string; complete?: boolean }>(["read"], [address]);
    return { text: result.text ?? "", draft: null, complete: result.complete === true };
  }

  async read(target: string, _lines: number, _region: "screen" | "history", observation?: AgentInfo): Promise<ScreenSnapshot> {
    const address = addressOf(target);
    // Do not infer the current foreground from a prior poll or from the pairing.
    if (observation && this.claudeReads.get(target)?.agent?.deref() === observation) {
      this.claudeReads.delete(target);
      const snapshot = await this.capture(address);
      return { ...snapshot, text: stripSidePane(snapshot.text) };
    }
    const before = await this.terminal(address);
    const redacted = { text: "", draft: null, complete: false };
    if (!before || before.state !== "live") return redacted;
    const claude = claudeForegroundPid(before) !== null ? await this.agentFrom(before) : null;
    const codex = isCodex(before);
    if (!claude && !codex) return redacted;
    const snapshot = await this.capture(address).catch((error: unknown) => {
      if (claude) throw error;
      return redacted;
    });
    const after = await this.terminal(address);
    if (after?.state !== "live") return redacted;
    const sameForeground = typeof before.foreground?.pid === "number" &&
      before.foreground.pid === after.foreground?.pid && before.foreground.name === after.foreground?.name;
    if (claude && sameForeground && claudeForegroundPid(after) !== null) {
      const current = await this.agentFrom(after);
      if (current?.agent === "claude" && current.sessionId === claude.sessionId && current.cwd === claude.cwd &&
          current.ref.processStartedAt === claude.ref.processStartedAt) {
        return { ...snapshot, text: stripSidePane(snapshot.text) };
      }
    }
    if (!codex || !isCodex(after) || before.turn !== after.turn) return redacted;

    const kind = after.status?.kind;
    const stable = sameForeground && before.status?.app === after.status?.app &&
      before.status?.state === after.status?.state && before.status?.kind === kind;
    if (after.status?.app === "codex" && after.status.state === "blocked") {
      const prompt = stable && (kind === "question" || kind === "permission") ? inspectHcCodexPrompt(snapshot, kind) : null;
      return { ...redacted, observedPrompt: { ...(prompt ?? { kind: "input", fingerprint: "input" }), turn: after.turn } };
    }
    if (!stable) return redacted;
    if (after.status == null && isHcCodexTrustPrompt(snapshot)) {
      return { ...redacted, observedPrompt: { kind: "trust", fingerprint: "trust", turn: after.turn } };
    }
    const prompt = inspectHcCodexPrompt(snapshot);
    if (prompt) return { ...redacted, observedPrompt: { ...prompt, turn: after.turn } };
    const [composer, footer, hint] = snapshot.text.split("\n").filter((row) => row.trim()).slice(-3);
    const composerVisible = /^›(?: |$)/u.test(composer ?? "") &&
      /^ {2}\S.* · \//u.test(footer ?? "") && /^ {2}← for agents · \? for shortcuts/u.test(hint ?? "");
    return after.status == null && snapshot.complete && composerVisible
      ? { ...redacted, codexTrustExited: true }
      : redacted;
  }

  private async assertWritable(ref: AgentRef, driver: AgentDriver): Promise<HcTerminal> {
    if (ref.agentKind === "codex" || driver.kind === "codex") {
      throw new ExpectationLost(HC_CODEX_WRITE_NOTICE, HC_CODEX_WRITE_NOTICE);
    }
    const address = addressOf(ref.target);
    const terminal = await this.terminal(address);
    if (terminal && isCodex(terminal)) throw new ExpectationLost(HC_CODEX_WRITE_NOTICE, HC_CODEX_WRITE_NOTICE);
    const pid = terminal ? claudeForegroundPid(terminal) : null;
    if (driver.kind !== "claude" || terminal?.address !== address || pid === null || ref.pid === null || !ref.sessionId) {
      throw new ExpectationLost(HC_CLAUDE_UNVERIFIED, HC_CLAUDE_UNVERIFIED);
    }
    if (pid !== ref.pid) throw new ExpectationLost(HC_CLAUDE_CHANGED, HC_CLAUDE_CHANGED);
    const session = await claudeSession(pid, this.sessionsDir);
    if (!session) throw new ExpectationLost(HC_CLAUDE_UNVERIFIED, HC_CLAUDE_UNVERIFIED);
    if (session.sessionId !== ref.sessionId || session.startedAt !== ref.processStartedAt) {
      throw new ExpectationLost(HC_CLAUDE_CHANGED, HC_CLAUDE_CHANGED);
    }
    return terminal;
  }

  async submit(ref: AgentRef, text: string, ctx: SubmitContext): Promise<SubmitOutcome> {
    let result: { started?: boolean };
    try {
      await this.assertWritable(ref, ctx.driver);
    } catch (err) {
      if (err instanceof ExpectationLost) throw new SubmitRefused("agent-unverified", err.message);
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

  openAnswer(ref: AgentRef, prompt: VerifiedPrompt, options?: { allowIdle?: boolean }): AnswerChannel {
    const channel = this.createAnswerChannel(ref, prompt, options?.allowIdle === true);
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
  private createAnswerChannel(ref: AgentRef, prompt: VerifiedPrompt, allowIdle = false): ModelAnswerChannel {
    const address = addressOf(ref.target);
    let firstWrite = true;
    let active = true;
    let pendingText: string | null = null;
    let answerStatus: AgentStatus = "unknown";
    const assertFingerprint = async (): Promise<void> => {
      const before = await this.assertWritable(ref, prompt.driver);
      answerStatus = normalizeStatus(before.status?.state);
      if (answerStatus !== "blocked" && !(allowIdle && (answerStatus === "idle" || answerStatus === "done"))) {
        throw new ExpectationLost(HC_BLOCKED_CHANGED, HC_BLOCKED_CHANGED);
      }
      const snapshot = await this.capture(address);
      if (!snapshot.complete) throw new ExpectationLost("the verified prompt screen is incomplete");
      const current = prompt.driver.parseBlockedPane(stripSidePane(snapshot.text));
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
      if (firstWrite && ref.agentKind !== "codex" && prompt.driver.kind !== "codex") await assertFingerprint();
      const current = await this.assertWritable(ref, prompt.driver);
      if (normalizeStatus(current.status?.state) !== answerStatus) {
        throw new ExpectationLost(HC_BLOCKED_CHANGED, HC_BLOCKED_CHANGED);
      }
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
        const before = await this.assertWritable(ref, prompt.driver);
        if (before.status?.state !== "blocked") throw new ExpectationLost(HC_BLOCKED_CHANGED, HC_BLOCKED_CHANGED);
        await this.json(["keys"], [address, choice]);
        if (prompt.form === "key-confirms") return;
        const after = await this.assertWritable(ref, prompt.driver);
        if (after.status?.state !== "blocked") throw new ExpectationLost(HC_BLOCKED_CHANGED, HC_BLOCKED_CHANGED);
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
