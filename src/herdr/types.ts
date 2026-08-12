export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface AgentInfo {
  agent: string; // "claude" | "codex" | ... — selects the driver, see agents/driver.ts
  sessionId: string | null; // agent_session.value, only trusted when kind === "id"
  agentStatus: AgentStatus;
  cwd: string;
  name?: string;
  /**
   * The pane's terminal tab title with any status glyph stripped — Claude
   * Code writes its own AI-generated conversation title here via an escape
   * sequence, so herdr already has it live regardless of whether that title
   * ever made it into the session transcript (verified: a 13MB transcript
   * with zero `ai-title` records still had its title here, because herdr
   * reads the terminal's own title state, not the transcript).
   */
  terminalTitle: string | null;
  paneId: string; // e.g. "wN:p1" — stable within a herdr run, used for send-keys/read
  terminalId: string; // e.g. "term_..." — stable pairing key across herdr restarts
  workspaceId: string;
}

/**
 * herdr's own account of how it decided a pane's state, from `agent explain
 * --json`. herdr classifies panes with a versioned rules manifest it keeps
 * updated itself (`~/.local/state/herdr/agent-detection/remote/<agent>.toml`),
 * and every rule has an id — so "what kind of prompt is on screen" is a
 * question herdr can already answer, rather than one cctag has to re-derive
 * from the screen with regexes it must maintain against every TUI change.
 *
 * `evaluatedRules` carries the verdict for *every* rule, not just the winner,
 * which is what lets a caller ask about a specific one it cares about.
 */
export interface AgentExplainRule {
  id: string;
  matched: boolean;
  priority: number;
  region: string;
  state: string;
}

export interface AgentExplain {
  state: AgentStatus;
  /** Highest-priority rule that matched, or null if none did. */
  matchedRule: AgentExplainRule | null;
  evaluatedRules: AgentExplainRule[];
  /** True when the matched rule required a blocker to be visible on screen. */
  visibleBlocker: boolean;
  /** Manifest version and whether herdr's copy is current — a stale manifest is
   *  the signature of an agent TUI that changed before herdr caught up. */
  manifestVersion: string | null;
  remoteUpdateStatus: string | null;
}

export class HerdrError extends Error {
  constructor(
    message: string,
    public readonly args: string[],
    public readonly stderr?: string,
  ) {
    super(message);
    this.name = "HerdrError";
  }
}
