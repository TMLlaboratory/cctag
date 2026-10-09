import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
import type { BlindPermissionPrompt, VerifiedModelMenuPrompt, VerifiedPrompt } from "./prompt.js";
import {
  BackendUnavailable,
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
  if (backendForTarget(raw.pane_id) === "orca") {
    throw new BackendUnavailable(`herdr target collision: reserved orca: namespace returned as ${raw.pane_id}`);
  }
  return {
    ref: { target: raw.pane_id, pid: null, processStartedAt: null },
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
  if (backendForTarget(target) === "orca") throw new UnknownTarget(`No Orca backend is available for target ${target}`);
}


export class HerdrBackend implements Terminals {
  constructor(private readonly bin: string) {}

  private async run(args: string[]): Promise<unknown> {
    let stdout: string;
    try {
      const result = await execFileAsync(this.bin, args, { timeout: 15_000 });
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
    assertHerdrTarget(target);
    try {
      const json = (await this.run(["agent", "get", target])) as { result?: { agent?: RawAgent } };
      const agent = json.result?.agent;
      return agent ? normalizeAgent(agent) : null;
    } catch (err) {
      if (err instanceof HerdrCliError && NOT_FOUND.test(err.stderr ?? err.message)) return null;
      if (err instanceof BackendUnavailable) throw err;
      throw new BackendUnavailable(errorMessage(err));
    }
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

  openBlind(ref: AgentRef, _prompt: BlindPermissionPrompt): BlindChannel {
    return { answer: (choice) => this.writeText(ref.target, choice) };
  }

  openComposer(ref: AgentRef, _driver: AgentDriver): ComposerChannel {
    return { backTab: () => this.writeBackTab(ref.target) };
  }

  async submit(ref: AgentRef, text: string, ctx: SubmitContext): Promise<SubmitOutcome> {
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
