import type { BlindPermissionPrompt, VerifiedPrompt } from "../backend/prompt.js";
import type { AnswerChannel, ComposerChannel, SubmitOutcome, Terminals } from "../backend/index.js";
import type { AgentInfo, AgentRef, ScreenSnapshot, TranscriptIdentity } from "../backend/types.js";
import { claudeDriver } from "./claude/driver.js";
import { codexDriver } from "./codex/driver.js";
import { ompDriver } from "./omp/driver.js";

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

export type PromptFingerprintInput =
  | { kind: "question"; info: AskUserQuestionPaneInfo }
  | { kind: "permission"; menu: PermissionMenu | null; isPlanPrompt: boolean; planFeedbackOptionNum?: number };

/** Parsed blocked screen. Only parsed menus carry a verified write capability. */
export type BlockedPrompt =
  | { kind: "question"; info: AskUserQuestionPaneInfo; verified: VerifiedPrompt }
  | {
      kind: "permission";
      menu: PermissionMenu;
      isPlanPrompt: boolean;
      planFeedbackOptionNum?: number;
      verified: VerifiedPrompt;
    }
  | { kind: "blind-permission"; blind: BlindPermissionPrompt }
  | { kind: "unreadable-question" };

export interface ModelCommandResult {
  reply: string;
  submitOutcome: SubmitOutcome | null;
}
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
 * `timestamp` is epoch milliseconds, or `null` when unparseable. Consumers
 * must treat `null` as time not proven, never as reason to release `blocked`.
 * `turnId` is carried where the format supplies one (Codex does; Claude Code
 * doesn't) so a completion can be matched to its start rather than inferred
 * from order alone.
 */
export type TurnLifecycleEvent =
  | { kind: "started"; timestamp: number | null; turnId?: string }
  | { kind: "completed"; timestamp: number | null; turnId?: string }
  | { kind: "aborted"; timestamp: number | null; turnId?: string };

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
  cycle(channel: ComposerChannel): Promise<void>;
}

/**
 * Agent-specific transcript, prompt, and slash-command behavior. Claude Code
 * and Codex CLI are driven through herdr; OMP is discovered by Orca and is
 * read-only. Each backend selects the matching driver from its live agent or
 * process identity rather than persisting that choice.
 */
export interface OrcaProcessIdentity {
  readonly pid: number;
  readonly command: string;
  readonly cwd: string | null;
  readonly piCodingAgentDirSet: boolean;
}

export interface OrcaProcessSession {
  readonly sessionId: string;
  readonly transcriptIdentity?: TranscriptIdentity;
}

export interface OrcaProcessAccess {
  homeDir: string;
  readFile(path: string): Promise<string>;
  readTranscriptHead(path: string): Promise<string>;
  runSystem(file: string, args: string[]): Promise<string>;
}

/** OS-process identity hooks used only by the Orca backend. */
export interface OrcaProcessDriver {
  /** Whether processes for this driver may be listed by Orca. */
  readonly listable: boolean;
  /** Hook-status mapping and notices owned by this agent's driver. */
  readonly hooks?: {
    readonly agent: string;
    readonly missingNotice: string;
    readonly unavailableNotice: string;
  };
  /** Notice included when a recognized driver is not supported by Orca. */
  readonly unsupportedNotice?: string;
  /** Notice included when a recognized process has no verifiable session. */
  readonly sessionUnavailableNotice?: string;
  matchesCommand(command: string): boolean;
  /** Missing session identity makes the process ineligible for listing. */
  session?(process: OrcaProcessIdentity, access: OrcaProcessAccess): Promise<OrcaProcessSession | null>;
}

export interface AgentDriver {
  readonly kind: string;
  readonly displayName: string;
  /** Optional process identity support for Orca; Herdr reports its own kind. */
  readonly orcaProcess?: OrcaProcessDriver;


  /**
   * Which `Terminals.read` region captures this agent's TUI. Herdr maps
   * `history` to scrollback and `screen` to the visible pane. Codex renders in
   * the alternate-screen buffer, so it needs `screen`; Claude works with
   * `history`.
   */
  readonly readRegion: "screen" | "history";

  /** Absolute path to the session transcript, or null if it can't be located
   *  (yet, or at all). `sessionId` may be null — some backends/setups don't
   *  report one, in which case the driver may still locate the transcript by cwd. */
  locateTranscript(cwd: string, sessionId: string | null): string | null;
  /** Assistant text + tool-call names from freshly-tailed transcript records. */
  extractTurnOutput(records: unknown[]): TurnOutput;
  /** Turn boundaries from transcript records, without extracting their output. */
  extractLifecycle(records: unknown[]): TurnLifecycleEvent[];

  /** Classifies what a `blocked` pane is currently showing. */
  parseBlockedPane(paneText: string): BlockedPrompt;
  /** Parses a complete post-submit review and, when supplied, verifies this answer's visible selection. */
  parseAnswerReview?(
    snap: ScreenSnapshot,
    expected?: { question: string; answers: readonly string[]; deadlineAt?: number },
  ): VerifiedPrompt | null;
  parseCursorLabel(snap: ScreenSnapshot): string | null;
  /** Drivers that can positively identify the idle composer; Orca fails closed when absent. */
  isIdleComposer?(snap: ScreenSnapshot): boolean;
  /** Moves composer text the backend left on screen into `draft`; returns the snapshot unchanged otherwise. */
  recoverComposerDraft?(snap: ScreenSnapshot): ScreenSnapshot;
  /** Whether this driver can distinguish a Claude prompt suggestion from a typed draft via a one-character probe. */
  composerProbe?: true;
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
  /** Confirms a numbered option with its digit; yes/no fallback uses a blind channel. */
  answerOption(channel: AnswerChannel, value: string, expectedLabel: string): Promise<void>;
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
    terminals: Terminals,
    channel: AnswerChannel,
    target: string,
    optionNum: number,
    answered: AskUserQuestionPaneInfo,
    /** Aborted when the pane's owner has been asked to stop. Checked before the
     *  confirming keystroke, which is the part that must not reach a pane
     *  something else may already have claimed. */
    signal?: AbortSignal,
  ): Promise<void>;
  /**
   * Answers a *multi-select* question: toggles the chosen options and submits.
   *
   * Separate from answerQuestionOption because the keystrokes are not the same
   * shape. Measured on a live 2.1.251 pane: a digit *toggles* a checkbox and
   * leaves the cursor where it was, so several digits accumulate a selection and
   * none of them submits — the opposite of the single-select list, where the
   * digit confirms on its own. Submitting then takes two more steps, hence a
   * dedicated method rather than a flag on the one above.
   *
   * Absent = this agent has no multi-select dialog, and cctag must not offer
   * one in Slack.
   */
  answerQuestionMultiSelect?(
    terminals: Terminals,
    channel: AnswerChannel,
    ref: AgentRef,
    /** 1-based option numbers, in the order they should be toggled. */
    optionNums: number[],
    info: AskUserQuestionPaneInfo,
    /** See answerQuestionOption's. */
    signal?: AbortSignal,
  ): Promise<void>;
  /** Free-text answer to a pending AskUserQuestion-style prompt. Absent = unsupported. */
  answerQuestionFreeText?(
    terminals: Terminals,
    channel: AnswerChannel,
    ref: AgentRef,
    info: AskUserQuestionPaneInfo,
    text: string,
    signal?: AbortSignal,
  ): Promise<void>;
  /** Free-text refinement of a pending plan-approval prompt. Absent = unsupported. */
  answerPlanFeedback?(
    channel: AnswerChannel,
    optionNum: number,
    text: string,
  ): Promise<void>;
  /** Resolves the on-disk plan file for a plan-approval prompt. Absent = no plan-file concept. */
  resolvePlanFile?(paneText: string): string | null;

  /** Shift+Tab-style mode ring, or null if this agent has no equivalent. */
  readonly modes: ModeSupport | null;
  /** Handles `@cctag model <argsText>` end-to-end, including its submit outcome. */
  runModelCommand(terminals: Terminals, agent: AgentInfo, argsText: string): Promise<ModelCommandResult>;
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
  omp: ompDriver,
};
export const ORCA_AGENT_DRIVERS: readonly AgentDriver[] = Object.freeze(Object.values(REGISTRY));


/** Unknown/missing agent kinds fall back to claude — preserves today's
 *  behavior for stale pairings and any herdr output this build doesn't
 *  recognize yet. */
export function driverFor(agentKind: string | undefined | null): AgentDriver {
  if (agentKind && REGISTRY[agentKind]) return REGISTRY[agentKind];
  return claudeDriver;
}
