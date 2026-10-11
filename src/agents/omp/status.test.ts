import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import type { ScreenSnapshot } from "../../backend/types.js";
import { SettleTracker, EMPTY_TRANSCRIPT_BOUNDARIES, type TranscriptBoundaries } from "../../settle.js";
import {
  createOmpStatusMemory,
  markOmpNoticePosted,
  resolveOmpStatus,
  type OmpStatusMemory,
} from "./status.js";

function capturedScreen(filename: string): ScreenSnapshot {
  const capture = JSON.parse(readFileSync(new URL(`./__fixtures__/${filename}`, import.meta.url), "utf8")) as {
    terminal: Record<string, unknown>;
  };
  const terminal = capture.terminal;
  const tail = terminal.tail;
  const validTail = Array.isArray(tail) && tail.every((row) => typeof row === "string");
  const rows = Array.isArray(tail) ? tail.filter((row): row is string => typeof row === "string") : [];
  return {
    text: rows.join("\n"),
    draft: typeof terminal.draft === "string" ? terminal.draft : null,
    complete:
      validTail &&
      terminal.source === "screen" &&
      terminal.status === "running" &&
      terminal.limited === false &&
      terminal.truncated === false,
  };
}

const WAITING = capturedScreen("ask-open.screen.json");
const IDLE = capturedScreen("idle.screen.json");
const WORKING = capturedScreen("working.screen.json");
const STARTED: TranscriptBoundaries = { lastStartAt: 1, lastEndAt: null, lastBoundary: "started" };
const ENDED: TranscriptBoundaries = { lastStartAt: null, lastEndAt: 2, lastBoundary: "ended" };

function runningTurn(): SettleTracker {
  const settle = new SettleTracker();
  settle.markTurnRunning();
  return settle;
}

function resolve(
  overrides: Partial<Parameters<typeof resolveOmpStatus>[0]> = {},
) {
  return resolveOmpStatus({
    settle: runningTurn(),
    boundaries: EMPTY_TRANSCRIPT_BOUNDARIES,
    previousStatus: "unknown",
    memory: createOmpStatusMemory(),
    snapshot: IDLE,
    ...overrides,
  });
}

test("OMP needs transcript-running evidence and a complete screen before classifying", () => {
  const noTranscript = resolve({ settle: new SettleTracker(), snapshot: WAITING });
  assert.equal(noTranscript.status, "unknown");
  assert.equal(noTranscript.releaseBlocked, false);
  assert.equal(noTranscript.extendDeadline, false);

  const incomplete = { ...WAITING, complete: false };
  const memory: OmpStatusMemory = {
    waitingFingerprint: "candidate",
    waitingSamples: 1,
    noticeFingerprint: "posted",
  };
  const unreadable = resolve({ snapshot: incomplete, previousStatus: "blocked", memory });
  assert.equal(unreadable.status, "blocked");
  assert.equal(unreadable.releaseBlocked, false);
  assert.equal(unreadable.extendDeadline, false);
  assert.equal(unreadable.notice, null);
  assert.deepEqual(
    unreadable.memory,
    { waitingFingerprint: null, waitingSamples: 0, noticeFingerprint: "posted" },
    "incomplete reads retain the notice fingerprint but break a consecutive waiting run",
  );
  const nextWaiting = resolve({ snapshot: WAITING, previousStatus: unreadable.status, memory: unreadable.memory });
  assert.equal(nextWaiting.memory.waitingSamples, 1);
  assert.equal(nextWaiting.notice, null);
});

test("a started transcript boundary permits a waiting screen to begin confirmation", () => {
  const first = resolve({
    settle: new SettleTracker(),
    boundaries: STARTED,
    snapshot: WAITING,
  });
  assert.equal(first.status, "unknown");
  assert.equal(first.memory.waitingSamples, 1);
  assert.equal(first.extendDeadline, false);
  assert.equal(first.notice, null);
});

test("two consecutive identical complete waiting screens block and post one notice", () => {
  const first = resolve({ snapshot: WAITING, previousStatus: "working" });
  assert.equal(first.status, "working");
  assert.equal(first.memory.waitingSamples, 1);
  assert.equal(first.notice, null);

  const second = resolve({ snapshot: WAITING, previousStatus: first.status, memory: first.memory });
  assert.equal(second.status, "blocked");
  assert.equal(second.extendDeadline, true);
  assert.equal(second.releaseBlocked, false);
  assert.equal(second.fingerprint, first.fingerprint);
  assert.match(second.notice ?? "", /omp が入力を待っています。端末で答えてください/u);

  const posted = markOmpNoticePosted(second.memory, second.fingerprint!);
  const repeated = resolve({ snapshot: WAITING, previousStatus: "blocked", memory: posted });
  assert.equal(repeated.status, "blocked");
  assert.equal(repeated.extendDeadline, true);
  assert.equal(repeated.notice, null);
});

test("a changed waiting fingerprint is announced only after its second consecutive sample", () => {
  const first = resolve({ snapshot: WAITING });
  const changed = { ...WAITING, text: WAITING.text.replace("<choice-A>", "<choice-X>") };
  const changedFirst = resolve({ snapshot: changed, memory: first.memory });
  assert.equal(changedFirst.memory.waitingSamples, 1);
  assert.equal(changedFirst.notice, null);
  const changedSecond = resolve({ snapshot: changed, memory: changedFirst.memory });
  assert.equal(changedSecond.status, "blocked");
  assert.notEqual(changedSecond.fingerprint, first.fingerprint);
  assert.ok(changedSecond.notice);
});

test("a complete working or idle composer releases blocked OMP and resets its notice", () => {
  const memory: OmpStatusMemory = {
    waitingFingerprint: "old-wait",
    waitingSamples: 2,
    noticeFingerprint: "old-wait",
  };
  for (const snapshot of [IDLE, WORKING]) {
    const resolution = resolve({ snapshot, previousStatus: "blocked", memory });
    assert.equal(resolution.status, "working");
    assert.equal(resolution.releaseBlocked, true);
    assert.equal(resolution.extendDeadline, false);
    assert.deepEqual(resolution.memory, createOmpStatusMemory());
  }
});

test("a transcript-observed end releases blocked OMP even when the screen is incomplete", () => {
  const settle = runningTurn();
  settle.observe([{ kind: "completed", timestamp: 2 }]);
  const resolution = resolve({
    settle,
    snapshot: { ...WAITING, complete: false },
    previousStatus: "blocked",
  });
  assert.equal(resolution.status, "idle");
  assert.equal(resolution.releaseBlocked, true);
  assert.deepEqual(resolution.memory, createOmpStatusMemory());
});

test("a historical end boundary alone does not release a fresh OMP turn", () => {
  const resolution = resolve({
    settle: new SettleTracker(),
    boundaries: ENDED,
    snapshot: { ...WAITING, complete: false },
    previousStatus: "blocked",
  });
  assert.equal(resolution.status, "blocked");
  assert.equal(resolution.releaseBlocked, false);
  assert.equal(resolution.extendDeadline, false);
});

test("completed and aborted transcript boundaries dominate stale waiting screens", () => {
  for (const kind of ["completed", "aborted"] as const) {
    const settle = runningTurn();
    settle.observe([{ kind, timestamp: 2 }]);
    const resolution = resolve({ settle, snapshot: WAITING, previousStatus: "blocked" });
    assert.equal(resolution.status, "idle", kind);
    assert.equal(resolution.releaseBlocked, true, kind);
    assert.equal(resolution.notice, null, kind);
  }
});
