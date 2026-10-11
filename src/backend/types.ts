export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export type BackendName = "herdr" | "orca";
export const WRITE_OUTCOME_UNKNOWN_MESSAGE = "送信できたか確認できません。端末を確かめてください";
export const UNSENDABLE_TEXT_MESSAGE = "入力に送信できない制御文字が含まれています。制御文字を除いてください。";

const UNSENDABLE_C0_CONTROL = /[\u0000-\u0008\u000B-\u001F]/u;

export function hasUnsendableC0Controls(value: string): boolean {
  return UNSENDABLE_C0_CONTROL.test(value);
}

export type StatusEvidence =
  | { kind: "classified"; status: AgentStatus }
  | { kind: "hint"; state: "working" | "waiting" | "done" | null; waitingSince: number | null };

export type AgentKind = "claude" | "codex" | "omp";

export interface TranscriptIdentity {
  readonly path: string;
  readonly device: string;
  readonly inode: string;
}

export interface AgentRef {
  readonly target: string;
  readonly pid: number | null;
  readonly processStartedAt: number | null;
  readonly agentKind?: AgentKind;
  readonly sessionId?: string | null;
  readonly transcriptIdentity?: TranscriptIdentity;
}

export interface AgentInfo {
  ref: AgentRef;
  backend: BackendName;
  agent: AgentKind;
  sessionId: string | null;
  transcriptIdentity?: TranscriptIdentity;
  cwd: string;
  evidence: StatusEvidence;
  /** Raw Orca worktree state for picker icons only; not status evidence. */
  pickerState?: string | null;
  terminalTitle: string | null;
  /** Display/debug snapshot from the backend; may go stale and never addresses a terminal. */
  terminalId: string;
  displayId: string;
}

export interface ScreenSnapshot {
  text: string;
  draft: string | null;
  complete: boolean;
}

export interface SubmitComposerState {
  readonly probe: "x" | "y" | null;
  readonly stash: "untouched" | "uncertain" | "stashed";
  readonly submitUncertain: boolean;
}

export const EMPTY_SUBMIT_COMPOSER_STATE: SubmitComposerState = {
  probe: null,
  stash: "untouched",
  submitUncertain: false,
};

export interface ListResult {
  agents: AgentInfo[];
  failures: { backend: BackendName; reason: string }[];
  complete: boolean;
  notices: string[];
}

export class SubmitRefused extends Error {
  constructor(
    readonly reason:
      | "not-idle"
      | "draft"
      | "probe-unverified"
      | "stash-unverified"
      | "gate"
      | "incomplete-screen"
      | "agent-changed"
      | "cancelled"
      | "unsafe-text",
    message: string,
    readonly composer: SubmitComposerState = EMPTY_SUBMIT_COMPOSER_STATE,
  ) {
    super(message);
  }
}

export class ExpectationLost extends Error {
  constructor(
    message: string,
    readonly userMessage?: string,
  ) {
    super(message);
  }
}
export class WriteOutcomeUnknown extends Error {
  constructor(
    cause?: unknown,
    readonly composer: SubmitComposerState = EMPTY_SUBMIT_COMPOSER_STATE,
  ) {
    super(WRITE_OUTCOME_UNKNOWN_MESSAGE, cause === undefined ? undefined : { cause });
  }
}


export class UnknownTarget extends Error {}
export class BackendUnavailable extends Error {}

