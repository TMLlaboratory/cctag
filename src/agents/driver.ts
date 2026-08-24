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

/**
 * Files the agent explicitly asked to hand to the user (Claude Code's
 * `SendUserFile`), not yet known to have succeeded.
 *
 * This replaced inferring intent from `Write` calls, which fired on artifacts
 * nobody wanted in the thread and missed the common case entirely (a chart
 * written by a shell command leaves no recoverable path). One tool use names
 * several files, hence `paths` rather than `path`.
 */
export interface SendFileRequest {
  toolUseId: string;
  paths: string[];
  /** The tool's own `caption`, used as the upload comment when present. */
  caption?: string;
}

/** How a tool use ended. `ok: false` covers both an outright failure and a
 *  human denying the permission prompt — neither of which changed the file. */
export interface ToolOutcome {
  toolUseId: string;
  ok: boolean;
}

/**
 * A turn boundary in the agent's own transcript — what SettleTracker decides
 * completion from, instead of trusting herdr's `agent_status` (see settle.ts).
 *
 * `turnId` is carried where the format supplies one (Codex does; Claude Code
 * doesn't) so a completion can be matched to its start rather than inferred
 * from order alone.
 */
export type TurnLifecycleEvent =
  | { kind: "started"; turnId?: string }
  | { kind: "completed"; turnId?: string }
  | { kind: "aborted"; turnId?: string };

export interface TurnOutput {
  texts: string[];
  toolNames: string[];
  /** Turn boundaries seen in this batch, in order. Absent = this driver
   *  reports none, which leaves completion to herdr's status as before. */
  lifecycle?: TurnLifecycleEvent[];
  /**
   * `SendUserFile` calls the agent made — the explicit "send this to the user"
   * signal, and the route we prefer over inferring intent from writes.
   *
   * Paired with `toolOutcomes` by the same tracker and for the same reason: a
   * `SendUserFile` whose permission prompt was denied must not be uploaded.
   * Absent for drivers with no equivalent tool (Codex), which is why
   * `.cctag/outbox` has to stay as their route.
   */
  sendFileRequests?: SendFileRequest[];
  /** Outcomes for tool uses seen in this or any earlier batch. */
  toolOutcomes?: ToolOutcome[];
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
  /**
   * A startup dialog waiting on a human before any prompt can land, or null.
   * Returns a short description for quoting back to the user.
   *
   * Needed separately from `parseBlockedPane` because herdr reports these panes
   * as `idle`, not `blocked` — measured for both the directory-trust dialog and
   * Codex's "update available" menu. Ordinary permission menus *do* flip to
   * `blocked`, so startup dialogs are the states that have to be looked for
   * rather than waited for.
   *
   * Deliberately not a list of known dialogs. Codex alone ships at least two,
   * and one of them defaults to running `brew upgrade` — enumerating them means
   * the next one added upstream silently reintroduces the bug. Anything shaped
   * like "numbered options waiting on Enter" counts.
   */
  parseStartupPrompt?(paneText: string): string | null;
  /**
   * Whether a pane whose menu could not be parsed still looks like a *question*
   * dialog rather than a permission one.
   *
   * Consulted only on the parse-failure path, to decide whether offering a
   * blind yes/no confirmation is safe. It isn't for a question: the buttons
   * send a bare `y`, which in a multi-select checkbox screen means nothing and
   * may toggle or submit an unintended choice. Absent = this agent has no
   * question dialogs to confuse a permission prompt with, so the fallback
   * stays as it was.
   */
  looksLikeQuestionScreen?(paneText: string): boolean;
  /** Confirms a numbered option (by digit, or a fallback key like "y"/"n"). */
  answerOption(herdr: HerdrClient, paneId: string, value: string): Promise<void>;
  /**
   * Answers a *question* option, which is not the same keystroke as confirming a
   * permission menu even though both are numbered lists.
   *
   * Measured on a live pane: in the classic list a digit selects and confirms in
   * one go, but in the preview renderer it only moves the cursor and Enter is
   * what confirms. Sending both unconditionally is wrong in the other direction
   * — after the digit has already confirmed and advanced, a trailing Enter would
   * confirm whatever is highlighted on the *next* question. So the driver looks
   * at the pane in between. Absent = the plain answerOption is enough.
   */
  answerQuestionOption?(
    herdr: HerdrClient,
    paneId: string,
    optionNum: number,
    answered: AskUserQuestionPaneInfo,
    /** Aborted when the pane's owner has been asked to stop. Checked before the
     *  confirming keystroke, which is the part that must not reach a pane
     *  something else may already have claimed. */
    signal?: AbortSignal,
  ): Promise<void>;
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

/**
 * Identity of the prompt currently on a pane, or null if nothing recognizable
 * is showing.
 *
 * Exists because herdr reports one `blocked` for every prompt: answering one at
 * the terminal and landing on the next never passes through a non-blocked
 * status, so "is this still the prompt we posted?" cannot be answered from
 * status alone. Comparing this across polls is what catches the substitution.
 *
 * Everything the user can change *without* resolving the prompt is deliberately
 * excluded, since a false difference would re-post a prompt that is still
 * pending — the very repetition this was untangled from. That means the cursor
 * marker (moved by arrow keys) and multi-select checkbox state (toggled with
 * space) are normalized away; the option text and the command being asked about
 * are what remain. Returns null rather than a fingerprint of nothing when the
 * pane doesn't parse, so an empty or garbled read is never mistaken for a
 * change.
 */
/** Drops every space, so a value rebuilt from wrapped lines compares equal
 *  however the terminal happened to break it. */
function squash(value: string): string {
  return value.replace(/\s+/g, "");
}

export function promptFingerprint(prompt: BlockedPrompt): string | null {
  if (prompt.kind === "question") {
    const info = prompt.info;
    // Descriptions and the multi-select flag are part of the question's identity:
    // without them, two consecutive prompts sharing a question and its labels but
    // differing in their explanations read as the same prompt. The checkbox
    // *state* stays excluded — that is the part a person toggles with space — but
    // whether the question is multi-select at all cannot change under them.
    return [
      "q",
      info.header,
      info.question,
      info.multiSelect ? "multi" : "single",
      // Whitespace stripped, not just collapsed: a description is rebuilt from
      // however many lines the column wrapped it into, joined with spaces, so
      // resizing the terminal changes where those spaces fall. Comparing with
      // them in would have re-posted a prompt that was still pending — the
      // false-positive direction this fingerprint exists to avoid.
      ...info.options.map((o) => `${squash(o.label)}\u0000${squash(o.description ?? "")}`),
    ].join("\u0001");
  }
  if (!prompt.menu) return null;
  const choices = prompt.menu.choices.map((c) => `${c.num}.${c.label}`).join(" ");
  // The cursor glyph sits at the start of whichever option is selected, and the
  // indentation shifts with it, so both are normalized away — but only there.
  // Stripping those characters everywhere collapsed real differences in the text
  // being asked about: `echo x > out` and `echo x out` produced one fingerprint.
  const context = prompt.menu.snippet
    .split("\n")
    .map((line) => line.replace(/^\s*[›❯>]\s?/, "").trim())
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return ["p", choices, context].join("\u0001");
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
