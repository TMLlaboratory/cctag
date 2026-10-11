import type { AgentStatus, ScreenSnapshot } from "../../backend/types.js";
import type { SettleTracker, StatusResolution, TranscriptBoundaries } from "../../settle.js";
import { classifyOmpScreen, formatOmpScreenNotice, ompScreenFingerprint } from "./prompts.js";

export interface OmpStatusMemory {
  waitingFingerprint: string | null;
  waitingSamples: number;
  noticeFingerprint: string | null;
}

export function createOmpStatusMemory(): OmpStatusMemory {
  return { waitingFingerprint: null, waitingSamples: 0, noticeFingerprint: null };
}

export interface OmpStatusResolution extends StatusResolution {
  memory: OmpStatusMemory;
  fingerprint: string | null;
  notice: string | null;
  /** False for unknown or incomplete evidence: those states cannot release a blocked screen. */
  releaseBlocked: boolean;
}

/**
 * Resolves OMP from lifecycle evidence and a complete live screen. Orca's
 * `state`/`agentWait` hints are deliberately not consulted: only an observed
 * transcript start makes screen classification meaningful.
 */
export function resolveOmpStatus(input: {
  settle: SettleTracker;
  boundaries: TranscriptBoundaries;
  previousStatus: AgentStatus;
  memory: OmpStatusMemory;
  snapshot: ScreenSnapshot | null;
}): OmpStatusResolution {
  const clearCandidate = (noticeFingerprint = input.memory.noticeFingerprint): OmpStatusMemory => ({
    waitingFingerprint: null,
    waitingSamples: 0,
    noticeFingerprint,
  });

  // The bounded tail can include an old turn's end. Only the tracker has seen
  // a completion after this turn's transcript baseline.
  if (input.settle.settledByTranscript) {
    return {
      status: "idle",
      extendDeadline: false,
      releaseBlocked: true,
      memory: createOmpStatusMemory(),
      fingerprint: null,
      notice: null,
    };
  }

  if (!input.snapshot?.complete) {
    return {
      status: input.previousStatus,
      extendDeadline: false,
      releaseBlocked: false,
      memory: clearCandidate(),
      fingerprint: null,
      notice: null,
    };
  }

  const turnRunning = input.settle.turnRunning || input.boundaries.lastBoundary === "started";
  if (!turnRunning) {
    return {
      status: "unknown",
      extendDeadline: false,
      releaseBlocked: false,
      memory: clearCandidate(),
      fingerprint: null,
      notice: null,
    };
  }
  const screenClass = classifyOmpScreen(input.snapshot);
  const fingerprint = ompScreenFingerprint(input.snapshot);
  if (screenClass === null) {
    return {
      status: input.previousStatus,
      extendDeadline: false,
      releaseBlocked: false,
      memory: clearCandidate(),
      fingerprint: null,
      notice: null,
    };
  }
  if (screenClass === "waiting" && fingerprint !== null) {
    const sameFingerprint = input.memory.waitingFingerprint === fingerprint;
    const waitingSamples = sameFingerprint ? Math.min(input.memory.waitingSamples + 1, 2) : 1;
    const memory = { ...input.memory, waitingFingerprint: fingerprint, waitingSamples };
    const confirmed = waitingSamples >= 2;
    return {
      status: confirmed ? "blocked" : input.previousStatus,
      extendDeadline: confirmed,
      releaseBlocked: false,
      screen: input.snapshot,
      memory,
      fingerprint,
      notice:
        confirmed && input.memory.noticeFingerprint !== fingerprint
          ? formatOmpScreenNotice(input.snapshot)
          : null,
    };
  }

  return {
    status: "working",
    extendDeadline: false,
    releaseBlocked: true,
    screen: input.snapshot,
    memory: clearCandidate(null),
    fingerprint,
    notice: null,
  };
}

export function markOmpNoticePosted(memory: OmpStatusMemory, fingerprint: string): OmpStatusMemory {
  return { ...memory, noticeFingerprint: fingerprint };
}
