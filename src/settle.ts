import type { AgentStatus, ScreenSnapshot, StatusEvidence } from "./backend/types.js";
import type { TurnLifecycleEvent } from "./agents/driver.js";

export function classifiedStatus(evidence: StatusEvidence): AgentStatus {
  return evidence.kind === "classified" ? evidence.status : "unknown";
}

/**
 * Whether the agent has finished its turn, decided from the agent's own
 * transcript rather than from herdr's `agent_status`.
 *
 * herdr's status is not a reliable "is the agent still answering?" signal. It
 * comes from prioritized detection rules evaluated against the pane, and a
 * lingering background shell trips one that outranks every idle rule: measured
 * on herdr 0.8.2 (detection manifest 2026.08.21.1), a pane whose agent was
 * plainly idle — empty prompt box, idle title glyph — reported `working`
 * indefinitely because `background_shell_working` (priority 965) beat
 * `live_prompt_box` (950) and `osc_title_idle` (250). `state_change_seq` never
 * moved. Both places that waited for `idle`/`done` therefore waited forever:
 * TurnEngine's poll loop burned its full timeout and reported one, and
 * BackgroundWatcher never posted output it had already collected.
 *
 * Deliberately NOT keyed on herdr's rule ids. Those ship in a remotely-updated
 * manifest and can be renamed or reprioritized without a herdr release, and the
 * offending rule is one of a family (background shells, background agents, MCP
 * tasks) — matching on them would be a fix with an expiry date.
 *
 * The transcript is the agent's own record of its work, so it is the thing that
 * actually knows. See the drivers' lifecycle extraction for what marks a
 * boundary in each format.
 */
export class SettleTracker {
  /**
   * `unknown` until a turn is seen to start. A completion only counts once a
   * start has been observed, which is what makes reading a stale boundary
   * harmless: TurnEngine re-resolves a transcript mid-turn and rewinds to
   * offset 0 when it does (see turn.ts's locate retry), so the records handed
   * here can begin with a *previous* turn's completion. Requiring the start
   * first means that is ignored instead of finalizing the turn that just began.
   */
  private phase: "unknown" | "running" | "finished" = "unknown";

  /** Declares a turn already in progress when its start predates this offset.
   *
   * Used when adopting a blocked terminal, whose screen proves the turn is live,
   * and when BackgroundWatcher baselines a transcript whose latest boundary is
   * `started`. Slack-initiated turns do not call this: their own `user` record
   * must arm a fresh tracker before a completion can settle it.
   */
  markTurnRunning(): void {
    this.phase = "running";
  }

  /** Feeds boundaries from a freshly-tailed batch, in order. */
  observe(events: readonly TurnLifecycleEvent[]): void {
    for (const event of events) {
      if (event.kind === "started") this.phase = "running";
      else if (this.phase === "running") this.phase = "finished";
    }
  }

  /** Whether the transcript itself says the turn that was running has ended. */
  get settledByTranscript(): boolean {
    return this.phase === "finished";
  }
  /** Whether a start has been observed and no completion has followed it. */
  get turnRunning(): boolean {
    return this.phase === "running";
  }

  /**
   * herdr's status, corrected only where the transcript contradicts it.
   *
   * `blocked` is returned untouched, always: a pane waiting on a permission or
   * question prompt must keep reaching the prompt-adoption path, and a prompt
   * is deliberately absent from the transcript until it has been answered — so
   * the transcript can never be evidence against a blocked pane. Everything
   * other than a `working` the transcript has already closed out is also
   * returned as-is, which keeps the failure direction safe: an agent whose
   * format grows a boundary this doesn't recognize simply behaves as it does
   * today rather than being declared finished early.
   */
  effectiveStatus(status: AgentStatus): AgentStatus {
    if (status === "blocked") return status;
    if (status === "working" && this.settledByTranscript) return "idle";
    return status;
  }
}

export interface TranscriptBoundaries {
  lastStartAt: number | null;
  lastEndAt: number | null;
  lastBoundary: "started" | "ended" | null;
}

export const EMPTY_TRANSCRIPT_BOUNDARIES: TranscriptBoundaries = Object.freeze({
  lastStartAt: null,
  lastEndAt: null,
  lastBoundary: null,
});

/** Most recent lifecycle event, plus the most recent timestamp for each side. */
export function transcriptBoundaries(events: readonly TurnLifecycleEvent[]): TranscriptBoundaries {
  let lastStartAt: number | null = null;
  let lastEndAt: number | null = null;
  let foundStart = false;
  let foundEnd = false;
  let lastBoundary: TranscriptBoundaries["lastBoundary"] = null;

  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    const started = event.kind === "started";
    if (lastBoundary === null) lastBoundary = started ? "started" : "ended";
    if (started && !foundStart) {
      foundStart = true;
      lastStartAt = event.timestamp;
    } else if (!started && !foundEnd) {
      foundEnd = true;
      lastEndAt = event.timestamp;
    }
    if (foundStart && foundEnd) break;
  }

  if (lastBoundary === null) return EMPTY_TRANSCRIPT_BOUNDARIES;
  return { lastStartAt, lastEndAt, lastBoundary };
}

export interface StatusScreenEvidence {
  snapshot: ScreenSnapshot;
  fingerprint: string | null;
}

export interface StatusResolution {
  status: AgentStatus;
  /** TurnEngine extends its deadline only when this is true. */
  extendDeadline: boolean;
  /** Complete screen retained so TurnEngine can reuse it if this resolution blocks. */
  screen?: ScreenSnapshot;
}

export async function resolveStatus(input: {
  evidence: StatusEvidence;
  settle: SettleTracker;
  boundaries: TranscriptBoundaries;
  previousStatus: AgentStatus;
  readScreen?: () => Promise<StatusScreenEvidence | null>;
}): Promise<StatusResolution> {
  if (input.evidence.kind === "classified") {
    // herdr can miss a prompt that cctag reads fine: in a named Claude Code
    // session the dialog gets a second, labelled bottom rule, and herdr's
    // blocked-form rule looks only below the last rule — so a question on screen
    // reported `idle` (issue #46). Only when the transcript says the turn is
    // still running is the screen worth a read; a prompt found there is blocked.
    if ((input.evidence.status === "idle" || input.evidence.status === "done") && input.settle.turnRunning) {
      let screen: StatusScreenEvidence | null;
      try {
        screen = (await input.readScreen?.()) ?? null;
      } catch {
        screen = null;
      }
      if (screen?.snapshot.complete && screen.fingerprint !== null) {
        return { status: "blocked", extendDeadline: true, screen: screen.snapshot };
      }
    }
    const status = input.settle.effectiveStatus(input.evidence.status);
    return { status, extendDeadline: status === "blocked" };
  }

  if (input.settle.settledByTranscript) return { status: "idle", extendDeadline: false };

  const { waitingSince, state } = input.evidence;
  if (waitingSince !== null && (input.boundaries.lastEndAt === null || input.boundaries.lastEndAt < waitingSince)) {
    // A null end timestamp cannot prove that the turn ended after waiting began;
    // treat it like no timed end so an existing blocked state is never released.
    return { status: "blocked", extendDeadline: true };
  }

  if (input.boundaries.lastBoundary === "started") {
    let screen: StatusScreenEvidence | null;
    try {
      screen = (await input.readScreen?.()) ?? null;
    } catch {
      screen = null;
    }
    if (!screen?.snapshot.complete) {
      // Do not extend: repeated unreadable screens must not keep a turn alive forever; no key is sent while unreadable.
      return { status: input.previousStatus, extendDeadline: false };
    }
    const blocked = screen.fingerprint !== null;
    return {
      status: blocked ? "blocked" : "working",
      extendDeadline: blocked,
      screen: screen.snapshot,
    };
  }

  if (input.boundaries.lastBoundary === "ended") {
    // A bounded suffix may contain a completion from before this turn/watch's
    // offset. Only lifecycle events observed by the tracker may settle it.
    const status =
      input.previousStatus === "blocked" || input.previousStatus === "working" ? input.previousStatus : "unknown";
    return { status, extendDeadline: false };
  }
  if (state === "working") return { status: "working", extendDeadline: false };
  if (state === "done") return { status: "idle", extendDeadline: false };
  return { status: "unknown", extendDeadline: false };
}
