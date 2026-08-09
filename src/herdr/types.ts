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
