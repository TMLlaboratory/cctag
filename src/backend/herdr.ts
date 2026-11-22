import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { parseClaudeHerdrComposer } from "../agents/claude/composer.js";
import type { AgentDriver } from "../agents/driver.js";
import type {
  AnswerChannel,
  BlindChannel,
  ComposerChannel,
  SubmitContext,
  SubmitOutcome,
  Terminals,
  ModelAnswerChannel,
} from "./index.js";
import { runHerdrRaw, sendHerdrKeys, sendHerdrText } from "./raw.js";
import { stripSidePane } from "./side-pane.js";
import { readHerdrVisibleAnsi } from "./herdr-screen.js";
import { submitClaudeComposer } from "./submit-claude-composer.js";
import type { BlindPermissionPrompt, VerifiedModelMenuPrompt, VerifiedPrompt } from "./prompt.js";
import {
  BackendUnavailable,
  SubmitRefused,
  WriteOutcomeUnknown,
  type AgentInfo,
  type AgentRef,
  type AgentStatus,
  type ListResult,
  type ScreenSnapshot,
  type StatusEvidence,
  ExpectationLost,
  UnknownTarget,
} from "./types.js";
import { backendForTarget } from "./target.js";

const execFileAsync = promisify(execFile);
const NOT_FOUND = /not found|no such|unknown target/i;
const KNOWN_STATUSES = new Set<AgentStatus>(["idle", "working", "blocked", "done", "unknown"]);
const ANSWER_PANE_LINES = 200;

interface RawAgent {
  agent: string;
  agent_session?: { kind: string; value: string };
  agent_status: string;
  cwd: string;
  terminal_id: string;
  name?: string;
  terminal_title_stripped?: string;
  pane_id: string;
}

class HerdrCliError extends Error {
  constructor(
    message: string,
    readonly stderr?: string,
  ) {
    super(message);
  }
}

function normalizeStatus(raw: string): AgentStatus {
  return KNOWN_STATUSES.has(raw as AgentStatus) ? (raw as AgentStatus) : "unknown";
}

function normalizeAgent(raw: RawAgent): AgentInfo {
  const reserved = backendForTarget(raw.pane_id);
  if (reserved !== "herdr") {
    throw new BackendUnavailable(`herdr target collision: reserved ${reserved} namespace returned as ${raw.pane_id}`);
  }
  return {
    ref: { target: raw.pane_id, pid: null, processStartedAt: null, terminalInstance: raw.terminal_id },
    backend: "herdr",
    agent: raw.agent as AgentInfo["agent"],
    sessionId: raw.agent_session?.kind === "id" ? raw.agent_session.value : null,
    cwd: raw.cwd,
    evidence: { kind: "classified", status: normalizeStatus(raw.agent_status) },
    terminalTitle: raw.terminal_title_stripped?.trim() || null,
    terminalId: raw.terminal_id,
    displayId: raw.name ?? raw.pane_id,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function evidenceStatus(evidence: StatusEvidence): AgentStatus {
  return evidence.kind === "classified" ? evidence.status : "unknown";
}

function assertHerdrTarget(target: string): void {
  const backend = backendForTarget(target);
  if (backend !== "herdr") throw new UnknownTarget(`No ${backend} backend is available for target ${target}`);
}


export class HerdrBackend implements Terminals {
  constructor(private readonly bin: string) {}

  private async run(args: string[], env?: NodeJS.ProcessEnv): Promise<unknown> {
    let stdout: string;
    try {
      const result = await execFileAsync(this.bin, args, { env, timeout: 15_000 });
      stdout = result.stdout;
    } catch (err) {
      const error = err as { message?: string; stderr?: string };
      throw new HerdrCliError(error.message ?? "herdr command failed", error.stderr);
    }
    try {
      return JSON.parse(stdout);
    } catch {
      throw new BackendUnavailable(`herdr returned non-JSON output: ${stdout.slice(0, 200)}`);
    }
  }

  async list(): Promise<ListResult> {
    try {
      const json = (await this.run(["agent", "list"])) as { result?: { agents?: RawAgent[] } };
      return {
        agents: (json.result?.agents ?? []).map(normalizeAgent),
        failures: [],
        complete: true,
        notices: [],
      };
    } catch (err) {
      return {
        agents: [],
        failures: [{ backend: "herdr", reason: errorMessage(err) }],
        complete: false,
        notices: [],
      };
    }
  }

  async get(target: string): Promise<AgentInfo | null> {
    return this.lookupAgent(target, false);
  }

  private async lookupAgent(target: string, requireOnlyClaude: boolean, env?: NodeJS.ProcessEnv): Promise<AgentInfo | null> {
    assertHerdrTarget(target);
    try {
      const json = (await this.run(["agent", "get", target], env)) as { result?: { agent?: RawAgent } };
      const agent = json.result?.agent;
      if (!agent) return null;
      const info = normalizeAgent(agent);
      if (info.agent === "claude") {
        const process = await this.foregroundClaude(target, requireOnlyClaude, env).catch(() => null);
        if (process) info.ref = { ...info.ref, ...process, sessionId: info.sessionId };
      }
      return info;
    } catch (err) {
      if (err instanceof HerdrCliError && NOT_FOUND.test(err.stderr ?? err.message)) return null;
      if (err instanceof BackendUnavailable) throw err;
      throw new BackendUnavailable(errorMessage(err));
    }
  }

  private async foregroundClaude(target: string, requireOnlyClaude: boolean, env?: NodeJS.ProcessEnv): Promise<{ pid: number; processStartedAt: number } | null> {
    const result = await this.run(["pane", "process-info", "--pane", target], env) as {
      result?: { process_info?: { pane_id?: string; foreground_process_group_id?: number; foreground_processes?: { name: string; pid: number }[] } };
    };
    const info = result.result?.process_info;
    const foreground = info?.foreground_processes;
    const pid = info?.foreground_process_group_id;
    if (info?.pane_id !== target || typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0 ||
      (requireOnlyClaude && foreground?.length !== 1) ||
      !foreground?.some((process) => process.pid === pid && process.name === "claude")) return null;
    const { stdout } = await execFileAsync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
      timeout: 2_000,
      env: { ...process.env, LC_ALL: "C" },
    });
    const processStartedAt = Date.parse(stdout.trim());
    return Number.isFinite(processStartedAt) ? { pid, processStartedAt } : null;
  }

  async exists(target: string): Promise<boolean> {
    assertHerdrTarget(target);
    try {
      await this.run(["pane", "get", target]);
      return true;
    } catch (err) {
      if (err instanceof HerdrCliError && NOT_FOUND.test(err.stderr ?? err.message)) return false;
      if (err instanceof BackendUnavailable) throw err;
      throw new BackendUnavailable(errorMessage(err));
    }
  }

  async read(target: string, lines: number, region: "screen" | "history"): Promise<ScreenSnapshot> {
    assertHerdrTarget(target);
    const args = ["pane", "read", target, "--source", region === "screen" ? "visible" : "recent"];
    if (lines > 0) args.push("--lines", String(lines));
    return { text: stripSidePane(await runHerdrRaw(this.bin, args)), draft: null, complete: true };
  }
  openAnswer(ref: AgentRef, prompt: VerifiedPrompt): AnswerChannel {
    const channel = this.createAnswerChannel(ref, prompt);
    return {
      digit: channel.digit,
      text: channel.text,
      move: channel.move,
      complete: channel.complete,
      confirm: channel.confirm,
    };
  }

  openModelAnswer(ref: AgentRef, prompt: VerifiedModelMenuPrompt): ModelAnswerChannel {
    if (
      prompt.capability !== "codex-model-menu" ||
      prompt.driver.kind !== "codex" ||
      prompt.form !== "digit-then-enter"
    ) {
      throw new ExpectationLost("Escape is restricted to verified Codex model-selection menus");
    }
    return this.createAnswerChannel(ref, prompt);
  }

  private createAnswerChannel(ref: AgentRef, prompt: VerifiedPrompt): ModelAnswerChannel {
    let firstWrite = true;
    let active = true;
    const readCurrent = () => this.read(ref.target, ANSWER_PANE_LINES, prompt.driver.readRegion);
    const assertFingerprint = (snapshot: ScreenSnapshot): void => {
      const current = prompt.driver.parseBlockedPane(snapshot.text);
      if (
        (current.kind !== "question" && current.kind !== "permission") ||
        current.verified.fingerprint !== prompt.fingerprint
      ) {
        throw new ExpectationLost("the verified prompt is no longer on screen");
      }
    };
    const assertActive = (): void => {
      if (!active) throw new ExpectationLost("the answer channel is already complete");
    };
    const write = async (action: () => Promise<void>, terminal = false): Promise<void> => {
      assertActive();
      if (firstWrite) assertFingerprint(await readCurrent());
      await action();
      firstWrite = false;
      if (terminal) active = false;
    };

    return {
      digit: (n, terminal = prompt.form === "digit-confirms") =>
        write(() => this.writeText(ref.target, String(n)), terminal),
      text: (value) => write(() => this.writeText(ref.target, value)),
      move: async (direction, count) => {
        assertActive();
        if (count <= 0) return;
        if (count === 1) await write(() => this.writeKeys(ref.target, direction));
        else await write(() => this.writeKeys(ref.target, ...Array(count).fill(direction)));
      },
      // expectedLabel is not a cursor check on Herdr. `terminal` keeps the
      // compound Submit Enter open until the final write.
      confirm: (_expectedLabel, terminal = true) =>
        write(() => this.writeKeys(ref.target, "Enter"), terminal),
      complete: () => {
        assertActive();
        if (firstWrite) throw new ExpectationLost("an answer channel cannot complete before its first write");
        active = false;
      },
      escape: () => write(() => this.writeKeys(ref.target, "Escape"), true),
    };
  }

  openBlind(ref: AgentRef, prompt: BlindPermissionPrompt): BlindChannel {
    return {
      answer: async (choice) => {
        await this.writeText(ref.target, choice);
        if (prompt.form === "key-confirms") return;
        await delay(150);
        await this.writeKeys(ref.target, "Enter");
      },
    };
  }

  openComposer(ref: AgentRef, _driver: AgentDriver): ComposerChannel {
    return { backTab: () => this.writeBackTab(ref.target) };
  }

  async submit(ref: AgentRef, text: string, ctx: SubmitContext): Promise<SubmitOutcome> {
    if (ctx.driver.kind === "claude") {
      return this.submitClaude(ref, text, ctx);
    }
    // Keep text and Enter atomic; retries retain TurnEngine's old guard: wait,
    // stop on cancel/transcript growth, then require idle or done.
    await this.submitPrompt(ref.target, text);
    for (let i = 0; i < ctx.retryLimit; i++) {
      await new Promise<void>((resolve) => setTimeout(resolve, ctx.pollIntervalMs));
      if (ctx.cancelled()) break;
      if (ctx.transcriptGrew() === true) break;
      const recheck = await this.get(ref.target).catch(() => null);
      if (!recheck) break;
      const status = evidenceStatus(recheck.evidence);
      if (status !== "idle" && status !== "done") break;
      await this.writeKeys(ref.target, "Enter");
    }
    return { status: "accepted", draftStashed: false };
  }

  private async submitClaude(ref: AgentRef, text: string, ctx: SubmitContext): Promise<SubmitOutcome> {
    const target = ref.target;
    assertHerdrTarget(target);
    const server = await this.run(["status", "server", "--json"]).catch(() => null) as {
      running?: boolean; compatible?: boolean; socket?: string;
    } | null;
    const socket = server?.running === true && server.compatible === true && server.socket;
    if (!socket) throw new SubmitRefused("incomplete-screen", "herdr did not report a compatible live socket");
    const env: NodeJS.ProcessEnv = { ...process.env, HERDR_SOCKET_PATH: socket };
    delete env.HERDR_CLIENT_SOCKET_PATH;
    delete env.HERDR_SESSION;
    return submitClaudeComposer(text, ctx, {
      read: async () => {
        const layout = (await this.run(["pane", "layout", "--pane", target], env)) as {
          result?: { layout?: { panes?: { pane_id?: string; rect?: { width?: number } }[] } };
        };
        const width = layout.result?.layout?.panes?.find((pane) => pane.pane_id === target)?.rect?.width;
        if (!width) return null;
        const pane = (await this.run(["pane", "get", target], env)) as {
          result?: { pane?: { terminal_id?: string; scroll?: { offset_from_bottom?: number } } };
        };
        if (pane.result?.pane?.terminal_id !== ref.terminalInstance ||
          pane.result?.pane?.scroll?.offset_from_bottom !== 0) return null;
        const ansi = await readHerdrVisibleAnsi(socket, target);
        if (!ansi) return null;
        const current = await this.lookupAgent(target, true, env).catch(() => null);
        if (!current || current.agent !== "claude" || ref.pid === null || ref.processStartedAt === null ||
          !ref.terminalInstance || current.terminalId !== ref.terminalInstance || current.ref.pid !== ref.pid ||
          current.ref.processStartedAt !== ref.processStartedAt || current.sessionId !== ref.sessionId) {
          throw new SubmitRefused("agent-changed", "herdr foreground no longer matches");
        }
        const status = evidenceStatus(current.evidence);
        if (status === "blocked") throw new SubmitRefused("gate", "herdr reports a blocked agent");
        if (status !== "idle" && status !== "done") throw new SubmitRefused("not-idle", "herdr agent is not idle");
        return parseClaudeHerdrComposer(ansi, width - 1);
      },
      key: async (...keys) => { await runHerdrRaw(this.bin, ["pane", "send-keys", target, ...keys], env); },
      send: async (composer) => {
        try {
          await this.run(["agent", "prompt", target, text], env);
        } catch (error) {
          if (error instanceof HerdrCliError && /"code"\s*:\s*"agent_blocked"/u.test(error.stderr ?? "")) {
            throw new SubmitRefused("gate", "herdr refused a blocked agent", composer);
          }
          throw new WriteOutcomeUnknown(error, { ...composer, submitUncertain: true });
        }
        return { status: "accepted", draftStashed: composer.stash === "stashed" };
      },
    });
  }

  private async writeText(target: string, text: string): Promise<void> {
    assertHerdrTarget(target);
    await sendHerdrText(this.bin, target, text);
  }

  private async writeKeys(target: string, ...keys: string[]): Promise<void> {
    assertHerdrTarget(target);
    await sendHerdrKeys(this.bin, target, ...keys);
  }

  private async writeBackTab(target: string): Promise<void> {
    assertHerdrTarget(target);
    await sendHerdrText(this.bin, target, "\x1b[Z");
  }

  private async submitPrompt(target: string, text: string): Promise<void> {
    assertHerdrTarget(target);
    await this.run(["agent", "prompt", target, text]);
  }
}
