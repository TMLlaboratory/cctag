import type { HerdrClient } from "../herdr/client.js";
import { claudeDriver } from "./claude/driver.js";
import { codexDriver } from "./codex/driver.js";

export interface PermissionChoice {
  num: string;
  label: string;
}

export interface PermissionMenu {
  choices: PermissionChoice[];
  snippet: string;
}

export interface AskUserQuestionOption {
  label: string;
  description?: string;
}

export interface AskUserQuestionPaneInfo {
  header: string;
  question: string;
  options: AskUserQuestionOption[];
  multiSelect: boolean;
}

/** What a `blocked` pane parses into — the shape TurnEngine's poll loop branches on. */
export type BlockedPrompt =
  | { kind: "question"; info: AskUserQuestionPaneInfo }
  | { kind: "permission"; menu: PermissionMenu | null; isPlanPrompt: boolean; planFeedbackOptionNum?: number };

export interface TurnOutput {
  texts: string[];
  toolNames: string[];
  /** Absolute paths of files the agent wrote during the turn, as reported by its
   *  transcript. Candidates for auto-upload to the thread — TurnEngine narrows
   *  them to the types worth attaching. Absent when the driver can't tell (see
   *  the Codex driver, whose file writes go through shell commands whose target
   *  paths aren't recoverable from the transcript). */
  attachmentPaths?: string[];
}

/** Shift+Tab-style mode ring (Claude Code only — Codex has no equivalent, so its driver's `modes` is null). */
export interface ModeSupport {
  ring: readonly string[];
  aliases: Record<string, string>;
  parseCurrent(paneText: string): string | null;
  cycle(herdr: HerdrClient, paneId: string): Promise<void>;
}

/**
 * Everything that differs between coding-agent CLIs cctag drives through
 * herdr: how to locate/parse the session transcript, how to read and answer a
 * blocked pane's prompt, and how to run agent-specific slash-command-style
 * operations (`@cctag model`, `@cctag mode`). Selected per-pane from herdr's
 * live-reported `agent` field via `driverFor()` — never persisted, so a pane
 * that changes which CLI is running in it picks up the right driver on the
 * very next interaction.
 */
export interface AgentDriver {
  readonly kind: string;
  readonly displayName: string;

  /**
   * Which `herdr pane read --source` mode reliably captures this agent's TUI.
   * Verified empirically: herdr's `recent`/`recent-unwrapped` (scrollback-based)
   * sources return empty for Codex CLI's TUI — it appears to render in the
   * terminal's alternate-screen buffer, which scrollback capture doesn't see —
   * so it needs `visible` (current screen contents) instead. Claude Code's TUI
   * works fine with `recent`, which is what production has always used.
   */
  readonly paneReadSource: "visible" | "recent";

  /** Absolute path to the session transcript, or null if it can't be located
   *  (yet, or at all). `sessionId` may be null — some agents/setups don't
   *  report one via herdr, in which case the driver may still be able to
   *  locate the transcript some other way (e.g. by cwd). */
  locateTranscript(cwd: string, sessionId: string | null): string | null;
  /** Assistant text + tool-call names from freshly-tailed transcript records. */
  extractTurnOutput(records: unknown[]): TurnOutput;

  /** Classifies what a `blocked` pane is currently showing. */
  parseBlockedPane(paneText: string): BlockedPrompt;
  /** Confirms a numbered option (by digit, or a fallback key like "y"/"n"). */
  answerOption(herdr: HerdrClient, paneId: string, value: string): Promise<void>;
  /** Free-text answer to a pending AskUserQuestion-style prompt. Absent = unsupported. */
  answerQuestionFreeText?(
    herdr: HerdrClient,
    paneId: string,
    info: AskUserQuestionPaneInfo,
    text: string,
  ): Promise<void>;
  /** Free-text refinement of a pending plan-approval prompt. Absent = unsupported. */
  answerPlanFeedback?(
    herdr: HerdrClient,
    paneId: string,
    optionNum: number,
    text: string,
  ): Promise<void>;
  /** Resolves the on-disk plan file for a plan-approval prompt. Absent = no plan-file concept. */
  resolvePlanFile?(paneText: string): string | null;

  /** Shift+Tab-style mode ring, or null if this agent has no equivalent. */
  readonly modes: ModeSupport | null;
  /** Handles `@cctag model <argsText>` end-to-end; returns the Slack reply text to post. */
  runModelCommand(herdr: HerdrClient, agent: { paneId: string }, argsText: string): Promise<string>;
}

const DANGER_WORDS_RE = /\b(rm\s+-rf|sudo|--force|DROP\s+TABLE)\b/i;
const REFUSAL_LABEL_RE = /no|cancel|拒否|キャンセル|don'?t/i;

export function isDangerousSnippet(snippet: string): boolean {
  return DANGER_WORDS_RE.test(snippet);
}

export function isRefusalLabel(label: string): boolean {
  return REFUSAL_LABEL_RE.test(label);
}

const REGISTRY: Record<string, AgentDriver> = {
  claude: claudeDriver,
  codex: codexDriver,
};

/** Unknown/missing agent kinds fall back to claude — preserves today's
 *  behavior for stale pairings and any herdr output this build doesn't
 *  recognize yet. */
export function driverFor(agentKind: string | undefined | null): AgentDriver {
  if (agentKind && REGISTRY[agentKind]) return REGISTRY[agentKind];
  return claudeDriver;
}
