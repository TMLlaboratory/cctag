import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentExplain, AgentExplainRule, AgentInfo, AgentStatus } from "./types.js";
import { HerdrError } from "./types.js";

const execFileAsync = promisify(execFile);

interface RawAgent {
  agent: string;
  agent_session?: { kind: string; value: string };
  agent_status: string;
  cwd: string;
  name?: string;
  terminal_title_stripped?: string;
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
}

const KNOWN_STATUSES = new Set<AgentStatus>(["idle", "working", "blocked", "done", "unknown"]);

function normalizeStatus(raw: string): AgentStatus {
  return KNOWN_STATUSES.has(raw as AgentStatus) ? (raw as AgentStatus) : "unknown";
}

function normalizeAgent(raw: RawAgent): AgentInfo {
  return {
    agent: raw.agent,
    sessionId: raw.agent_session?.kind === "id" ? raw.agent_session.value : null,
    agentStatus: normalizeStatus(raw.agent_status),
    cwd: raw.cwd,
    name: raw.name,
    terminalTitle: raw.terminal_title_stripped?.trim() || null,
    paneId: raw.pane_id,
    terminalId: raw.terminal_id,
    workspaceId: raw.workspace_id,
  };
}

export class HerdrClient {
  constructor(private readonly bin: string) {}

  private async run(args: string[]): Promise<unknown> {
    let stdout: string;
    try {
      const result = await execFileAsync(this.bin, args, { timeout: 15_000 });
      stdout = result.stdout;
    } catch (err) {
      const e = err as { message?: string; stderr?: string };
      throw new HerdrError(e.message ?? "herdr command failed", args, e.stderr);
    }
    try {
      return JSON.parse(stdout);
    } catch {
      throw new HerdrError(`herdr returned non-JSON output: ${stdout.slice(0, 200)}`, args);
    }
  }

  /** Raw text output; used for pane read, which is NOT JSON. */
  private async runRaw(args: string[]): Promise<string> {
    try {
      const result = await execFileAsync(this.bin, args, { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
      return result.stdout;
    } catch (err) {
      const e = err as { message?: string; stderr?: string };
      throw new HerdrError(e.message ?? "herdr command failed", args, e.stderr);
    }
  }

  async agentList(): Promise<AgentInfo[]> {
    const json = (await this.run(["agent", "list"])) as { result?: { agents?: RawAgent[] } };
    const agents = json.result?.agents ?? [];
    return agents.map(normalizeAgent);
  }

  /** `paneId` — herdr 0.7.5+ only resolves agent-level commands by a unique
   *  agent name or the pane id currently hosting the agent; terminal_id is no
   *  longer a valid target (see pairing.ts's Pairing.paneId doc). */
  async agentGet(paneId: string): Promise<AgentInfo | null> {
    try {
      const json = (await this.run(["agent", "get", paneId])) as { result?: { agent?: RawAgent } };
      const agent = json.result?.agent;
      return agent ? normalizeAgent(agent) : null;
    } catch (err) {
      if (err instanceof HerdrError && /not found|no such|unknown target/i.test(err.stderr ?? err.message)) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Whether the pane itself still exists, regardless of what is running in it.
   *
   * The distinction agentGet cannot make: quitting the CLI to restart it leaves
   * the pane at a shell prompt, and `agent get` then answers `agent_not_found` —
   * indistinguishable from a closed terminal unless the pane is asked about
   * separately (verified on a live pane: `pane get` still returned it, with
   * agent_status "unknown"). Pairings are addressed by pane id precisely so they
   * survive that restart, so telling the two apart is what keeps them.
   *
   * Throws on anything other than a not-found answer: a herdr timeout must not be
   * reported as a missing pane.
   */
  async paneExists(paneId: string): Promise<boolean> {
    try {
      await this.run(["pane", "get", paneId]);
      return true;
    } catch (err) {
      if (err instanceof HerdrError && /not found|no such|unknown target/i.test(err.stderr ?? err.message)) {
        return false;
      }
      throw err;
    }
  }

  /**
   * herdr's own classification of what is on the pane right now.
   *
   * Unlike every other command here, `agent explain` prints human-readable text
   * by default and only emits JSON with `--json` (undocumented in its `--help`,
   * verified against a live pane), hence the extra flag.
   *
   * Returns null rather than throwing when herdr can't answer: this is
   * supplementary information, so a caller that already has a pane read must be
   * able to carry on without it.
   */
  async agentExplain(paneId: string): Promise<AgentExplain | null> {
    interface RawRule {
      id?: string;
      matched?: boolean;
      priority?: number;
      region?: string;
      state?: string;
    }
    const toRule = (raw: RawRule | undefined | null): AgentExplainRule | null =>
      raw?.id
        ? {
            id: raw.id,
            matched: raw.matched === true,
            priority: typeof raw.priority === "number" ? raw.priority : 0,
            region: raw.region ?? "",
            state: raw.state ?? "",
          }
        : null;

    let json: unknown;
    try {
      json = await this.run(["agent", "explain", paneId, "--json"]);
    } catch {
      return null;
    }
    const raw = json as {
      state?: string;
      matched_rule?: RawRule | null;
      evaluated_rules?: RawRule[];
      visible_blocker?: boolean;
      manifest_version?: string | null;
      remote_update_status?: string | null;
    };
    if (typeof raw.state !== "string") return null;
    return {
      state: normalizeStatus(raw.state),
      matchedRule: toRule(raw.matched_rule),
      evaluatedRules: (raw.evaluated_rules ?? []).map(toRule).filter((r): r is AgentExplainRule => r !== null),
      visibleBlocker: raw.visible_blocker === true,
      manifestVersion: raw.manifest_version ?? null,
      remoteUpdateStatus: raw.remote_update_status ?? null,
    };
  }

  /**
   * Sends literal text into the target's input box. Does NOT submit — call
   * paneSendKeys(..., "Enter") separately.
   *
   * herdr 0.7.5 removed the `agent send` command. Its CHANGELOG calls
   * `agent send-keys` the replacement, but that command only accepts
   * recognized key *names* (like tmux send-keys without -l) and rejects any
   * multi-word literal string with `invalid_key` — verified empirically
   * against a live pane. `pane send-text` ("Send literal text to a pane",
   * single free-form `text` param) is what actually does what `agent send`
   * used to; herdr has no agent-scoped equivalent, but pane- and
   * agent-level commands address the same underlying pane, so this works.
   */
  async agentSend(paneId: string, text: string): Promise<void> {
    await this.runRaw(["pane", "send-text", paneId, text]);
  }

  /**
   * Submits a prompt atomically — text injection *and* the Enter that submits
   * it, done server-side in one operation (herdr 0.7.5+ `agent prompt`).
   *
   * Prefer this over agentSend()+paneSendKeys("Enter") for the common
   * "type a message and send it" path: those are two separate herdr calls
   * bridged by a fixed sleep, and Claude Code's TUI coalesces the injected
   * text as a paste — if the Enter arrives before that paste settles it gets
   * absorbed as a newline instead of submitting (the text sits unsent in the
   * box until the next send flushes it). `agent prompt` sequences the two
   * itself, honoring live bracketed-paste mode before the Enter, so there's
   * no client-side race and no sleep to guess.
   *
   * Fire-and-forget (no --wait): submits and returns immediately, leaving
   * TurnEngine's own poll loop to track the turn as before.
   */
  async agentPrompt(paneId: string, text: string): Promise<void> {
    await this.run(["agent", "prompt", paneId, text]);
  }

  /** `pane send-keys` prints nothing on success (unlike other subcommands) — don't JSON-parse it. */
  async paneSendKeys(paneId: string, ...keys: string[]): Promise<void> {
    await this.runRaw(["pane", "send-keys", paneId, ...keys]);
  }

  /**
   * Writes literal text straight to the pane's PTY (`pane send-text`). Used
   * for control sequences that `send-keys` can't express: notably Shift+Tab
   * (backtab), which Claude Code cycles its permission/plan/auto mode with.
   * `send-keys shift+tab` is accepted by herdr but delivers nothing Claude
   * Code reacts to; the raw CSI Z sequence ("\x1b[Z") sent as text does work
   * (verified empirically). Prints nothing on success — don't JSON-parse it.
   */
  async paneSendText(paneId: string, text: string): Promise<void> {
    await this.runRaw(["pane", "send-text", paneId, text]);
  }

  async paneRead(
    paneId: string,
    opts: { source?: "visible" | "recent" | "recent-unwrapped"; lines?: number } = {},
  ): Promise<string> {
    const args = ["pane", "read", paneId];
    if (opts.source) args.push("--source", opts.source);
    if (opts.lines) args.push("--lines", String(opts.lines));
    return this.runRaw(args);
  }

  /** `pane run` prints nothing on success — don't JSON-parse it. */
  async paneRun(paneId: string, command: string): Promise<void> {
    await this.runRaw(["pane", "run", paneId, command]);
  }

  async paneClose(paneId: string): Promise<void> {
    await this.run(["pane", "close", paneId]);
  }

  async agentStart(name: string, cwd: string, argv: string[]): Promise<AgentInfo> {
    const json = (await this.run([
      "agent",
      "start",
      name,
      "--cwd",
      cwd,
      "--no-focus",
      "--",
      ...argv,
    ])) as { result?: { agent?: RawAgent } };
    const agent = json.result?.agent;
    if (!agent) throw new HerdrError("agent start returned no agent", ["agent", "start", name]);
    return normalizeAgent(agent);
  }
}
