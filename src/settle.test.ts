import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EMPTY_TRANSCRIPT_BOUNDARIES,
  IDLE_AGAINST_RUNNING_GRACE_MS,
  resolveStatus,
  SettleTracker,
  transcriptBoundaries,
} from "./settle.js";
import { readLastMatchingRecordBefore, readNewRecords, readRecentRecords } from "./agents/transcript.js";
import { extractLifecycle, type TranscriptRecord } from "./agents/claude/transcript.js";

// --- the tracker itself -----------------------------------------------------

test("a completion only counts once a start has been seen", () => {
  // The guard that makes a stale boundary harmless: TurnEngine rewinds to
  // offset 0 when it resolves a transcript mid-turn, so the first records
  // handed over can belong to a *previous* turn.
  const t = new SettleTracker();
  t.observe([{ kind: "completed", timestamp: 1 }]);
  assert.equal(t.settledByTranscript, false, "a completion with no start is a leftover, not this turn");
  assert.equal(t.effectiveStatus("working"), "working");

  t.observe([{ kind: "started", timestamp: 1 }, { kind: "completed", timestamp: 2 }]);
  assert.equal(t.settledByTranscript, true);
  assert.equal(t.effectiveStatus("working"), "idle");
});

test("a pane herdr reports as working is left alone until the transcript closes the turn", () => {
  // The load-bearing property. A real 40-minute turn produces a start and then
  // nothing but tool traffic; declaring it finished would release the pane, let
  // the watcher rebaseline, and drop the output.
  const t = new SettleTracker();
  t.observe([{ kind: "started", timestamp: 1 }]);
  for (let i = 0; i < 500; i++) t.observe([]); // polls with no new boundary
  assert.equal(t.settledByTranscript, false);
  assert.equal(t.effectiveStatus("working"), "working", "silence is not completion");
});

test("blocked is never rewritten, even after the transcript closed a turn", () => {
  // A pending prompt is deliberately absent from the transcript until answered,
  // so the transcript can never be evidence against a blocked pane — and the
  // prompt-adoption path keys on exactly this status.
  const t = new SettleTracker();
  t.observe([{ kind: "started", timestamp: 1 }, { kind: "completed", timestamp: 2 }]);
  assert.equal(t.effectiveStatus("blocked"), "blocked");
});

test("statuses other than working pass through untouched", () => {
  const t = new SettleTracker();
  t.observe([{ kind: "started", timestamp: 1 }, { kind: "completed", timestamp: 2 }]);
  assert.equal(t.effectiveStatus("idle"), "idle");
  assert.equal(t.effectiveStatus("done"), "done");
  assert.equal(t.effectiveStatus("unknown"), "unknown");
});

test("a new start re-arms the tracker for the next turn", () => {
  // The watcher's tracker outlives a single turn, so a settled one must not
  // stay settled once the next terminal-side turn begins.
  const t = new SettleTracker();
  t.observe([{ kind: "started", timestamp: 1 }, { kind: "completed", timestamp: 2 }]);
  assert.equal(t.effectiveStatus("working"), "idle");
  t.observe([{ kind: "started", timestamp: 3 }]);
  assert.equal(t.effectiveStatus("working"), "working", "the next turn is running again");
});

test("an adopted pane settles on the completion it was handed mid-turn", () => {
  // Its start predates the handoff's offset, so without markTurnRunning the
  // completion that eventually arrives would be ignored and an adopted turn on
  // a stuck-working pane would never finalize.
  const t = new SettleTracker();
  t.markTurnRunning();
  t.observe([{ kind: "completed", timestamp: 1 }]);
  assert.equal(t.effectiveStatus("working"), "idle");
});

test("a Claude interrupt marker ends the turn instead of re-arming", () => {
  const records = readFileSync(
    new URL("./agents/claude/__fixtures__/claude-interrupt.jsonl", import.meta.url),
    "utf8",
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as TranscriptRecord);
  const events = extractLifecycle(records);
  assert.deepEqual(events.map((event) => event.kind), ["started", "aborted"]);

  const t = new SettleTracker();
  t.observe(events);
  assert.equal(t.effectiveStatus("working"), "idle");
});

test("an unknown boundary time does not suppress the existing settle transition", () => {
  const t = new SettleTracker();
  t.observe([{ kind: "started", timestamp: null }, { kind: "aborted", timestamp: null }]);
  assert.equal(t.effectiveStatus("working"), "idle");
  assert.equal(t.effectiveStatus("blocked"), "blocked");
});

// --- Claude Code boundary extraction ---------------------------------------

const userMsg = {
  type: "user",
  timestamp: "2026-09-27T14:48:48.520Z",
  message: { role: "user", content: "やって" },
};
const toolResult = {
  type: "user",
  timestamp: "2026-09-27T14:49:01.082Z",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1" }] },
};
const assistantWith = (stop: string | null, blocks: unknown[]) => ({
  type: "assistant",
  timestamp: "2026-09-27T14:48:53.416Z",
  message: { role: "assistant", stop_reason: stop, content: blocks },
});
const turnDuration = {
  type: "system",
  subtype: "turn_duration",
  timestamp: "2026-09-27T14:48:53.416Z",
  durationMs: 2737,
};

test("turn_duration is a completion", () => {
  assert.deepEqual(extractLifecycle([turnDuration]), [
    { kind: "completed", timestamp: Date.parse(turnDuration.timestamp) },
  ]);
});

test("a real user message starts a turn but a tool_result does not", () => {
  // Tool results come back as `user` records too; treating them as starts would
  // re-arm the tracker on every tool call in the turn.
  assert.deepEqual(extractLifecycle([userMsg]), [{ kind: "started", timestamp: Date.parse(userMsg.timestamp) }]);
  assert.deepEqual(extractLifecycle([toolResult]), []);
});

test("a text block emitted alongside tool calls is not a completion", () => {
  // The stop_reason belongs to the API response, not the block, so a response
  // that ends in tool calls stamps `tool_use` on its text block too. This is
  // what keeps the fallback from firing mid-turn.
  assert.deepEqual(
    extractLifecycle([assistantWith("tool_use", [{ type: "text", text: "調べます" }, { type: "tool_use", id: "t1" }])]),
    [],
  );
});

test("an interrupted response is not a completion", () => {
  assert.deepEqual(extractLifecycle([assistantWith(null, [{ type: "text", text: "途中" }])]), []);
});

test("one response split across content blocks yields repeated completions, which settle the same as one", () => {
  // Measured in production: a reply with a thinking block and a text block
  // writes two records, both stamped end_turn. Idempotent for settling.
  const events = extractLifecycle([
    userMsg,
    assistantWith("end_turn", [{ type: "thinking" }]),
    assistantWith("end_turn", [{ type: "text", text: "できました" }]),
    turnDuration,
  ]);
  assert.deepEqual(events, [
    { kind: "started", timestamp: Date.parse(userMsg.timestamp) },
    { kind: "completed", timestamp: Date.parse(assistantWith("end_turn", []).timestamp) },
    { kind: "completed", timestamp: Date.parse(assistantWith("end_turn", []).timestamp) },
    { kind: "completed", timestamp: Date.parse(turnDuration.timestamp) },
  ]);
  const t = new SettleTracker();
  t.observe(events);
  assert.equal(t.effectiveStatus("working"), "idle");
});

function localCommandFixture(name: string) {
  return readFileSync(new URL(`./agents/claude/__fixtures__/${name}`, import.meta.url), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

test("herdr's status after a local command: working settles, blocked is left alone", () => {
  const t = new SettleTracker();
  t.observe(extractLifecycle(localCommandFixture("claude-compact.jsonl")));
  assert.equal(t.effectiveStatus("working"), "idle");
  assert.equal(t.effectiveStatus("idle"), "idle");
  assert.equal(t.effectiveStatus("blocked"), "blocked");
});

test("stop_sequence and max_tokens end a turn as well", () => {
  assert.deepEqual(extractLifecycle([assistantWith("stop_sequence", [])]), [
    { kind: "completed", timestamp: Date.parse(assistantWith("stop_sequence", []).timestamp) },
  ]);
  assert.deepEqual(extractLifecycle([assistantWith("max_tokens", [])]), [
    { kind: "completed", timestamp: Date.parse(assistantWith("max_tokens", []).timestamp) },
  ]);
});

test("subagent records never arm or settle the pane's turn", () => {
  // A sidechain's turns are not the pane's turn; reporting one as the pane's
  // completion would finalize a turn that is still running.
  const events = extractLifecycle([
    { ...userMsg, isSidechain: true },
    { ...turnDuration, isSidechain: true },
    { ...assistantWith("end_turn", []), isSidechain: true },
  ]);
  assert.deepEqual(events, []);
});

const V2_LIFECYCLE = extractLifecycle(
  readFileSync(new URL("./agents/claude/__fixtures__/claude-interrupt.jsonl", import.meta.url), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as TranscriptRecord),
);
const V2_STARTED = V2_LIFECYCLE.find((event) => event.kind === "started")!;
const V2_ENDED = V2_LIFECYCLE.find((event) => event.kind === "aborted")!;
const V2_START_AT = V2_STARTED.timestamp!;
const V2_END_AT = V2_ENDED.timestamp!;

const hint = (state: "working" | "waiting" | "done" | null, waitingSince: number | null) => ({
  kind: "hint" as const,
  state,
  waitingSince,
});

test("classified status resolution matches SettleTracker exactly", async () => {
  const settle = new SettleTracker();
  settle.observe(V2_LIFECYCLE);
  for (const status of ["idle", "working", "blocked", "done", "unknown"] as const) {
    const resolved = await resolveStatus({
      evidence: { kind: "classified", status },
      settle,
      boundaries: EMPTY_TRANSCRIPT_BOUNDARIES,
      previousStatus: "unknown",
    });
    assert.equal(resolved.status, settle.effectiveStatus(status));
    assert.equal(resolved.extendDeadline, resolved.status === "blocked");
  }
});

test("a strong waitingSince hint wins over an incomplete screen", async () => {
  let reads = 0;
  const resolved = await resolveStatus({
    evidence: hint("waiting", V2_START_AT + 1),
    settle: new SettleTracker(),
    boundaries: transcriptBoundaries([V2_STARTED]),
    previousStatus: "working",
    readScreen: async () => {
      reads++;
      return { snapshot: { text: "partial", draft: null, complete: false }, fingerprint: null };
    },
  });
  assert.equal(resolved.status, "blocked");
  assert.equal(resolved.extendDeadline, true);
  assert.equal(reads, 0, "row 1 must decide before the incomplete-screen row");
});

test("an incomplete screen preserves a blocked status without extending its deadline", async () => {
  const resolved = await resolveStatus({
    evidence: hint("working", null),
    settle: new SettleTracker(),
    boundaries: transcriptBoundaries([V2_STARTED]),
    previousStatus: "blocked",
    readScreen: async () => ({
      snapshot: { text: "partial", draft: null, complete: false },
      fingerprint: null,
    }),
  });
  assert.equal(resolved.status, "blocked");
  assert.equal(resolved.extendDeadline, false, "the existing deadline remains unchanged");
});

test("a thrown screen read preserves the previous blocked status without extending its deadline", async () => {
  const resolved = await resolveStatus({
    evidence: hint("working", null),
    settle: new SettleTracker(),
    boundaries: transcriptBoundaries([V2_STARTED]),
    previousStatus: "blocked",
    readScreen: async () => {
      throw new Error("screen read unavailable");
    },
  });
  assert.equal(resolved.status, "blocked");
  assert.equal(resolved.extendDeadline, false);
});

test("a running transcript uses a complete screen fingerprint to distinguish blocked from working", async () => {
  const boundaries = transcriptBoundaries([V2_STARTED]);
  const blocked = await resolveStatus({
    evidence: hint("working", null),
    settle: new SettleTracker(),
    boundaries,
    previousStatus: "working",
    readScreen: async () => ({
      snapshot: { text: "permission prompt", draft: null, complete: true },
      fingerprint: "permission",
    }),
  });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.extendDeadline, true);

  const working = await resolveStatus({
    evidence: hint("working", null),
    settle: new SettleTracker(),
    boundaries,
    previousStatus: "blocked",
    readScreen: async () => ({
      snapshot: { text: "empty composer", draft: null, complete: true },
      fingerprint: null,
    }),
  });
  assert.equal(working.status, "working");
  assert.equal(working.extendDeadline, false);
});

test("a transcript end newer than waitingSince resolves to idle", async () => {
  const settle = new SettleTracker();
  settle.observe(V2_LIFECYCLE);
  const resolved = await resolveStatus({
    evidence: hint("working", Math.floor((V2_START_AT + V2_END_AT) / 2)),
    settle,
    boundaries: transcriptBoundaries(V2_LIFECYCLE),
    previousStatus: "working",
  });
  assert.equal(resolved.status, "idle");
  assert.equal(resolved.extendDeadline, false);
});

test("a historical transcript end before waitingSince still blocks", async () => {
  const resolved = await resolveStatus({
    evidence: hint("waiting", V2_END_AT + 1),
    settle: new SettleTracker(),
    boundaries: transcriptBoundaries(V2_LIFECYCLE),
    previousStatus: "working",
  });
  assert.equal(resolved.status, "blocked");
  assert.equal(resolved.extendDeadline, true);
});

test("a turn the transcript ended is not kept alive by a later waiting hint", async () => {
  // Whether Orca keeps reporting waiting after a turn ends is not captured; if it
  // does, the hint must not hold the ended turn open as blocked.
  const settle = new SettleTracker();
  settle.observe(V2_LIFECYCLE);
  const resolved = await resolveStatus({
    evidence: hint("waiting", V2_END_AT + 1),
    settle,
    boundaries: transcriptBoundaries(V2_LIFECYCLE),
    previousStatus: "blocked",
  });
  assert.deepEqual(resolved, { status: "idle", extendDeadline: false });
});

test("an unknown end timestamp cannot release a waiting hint", async () => {
  const boundaries = transcriptBoundaries([
    V2_STARTED,
    { kind: "aborted", timestamp: null },
  ]);
  assert.equal(boundaries.lastEndAt, null);
  const resolved = await resolveStatus({
    evidence: hint("waiting", V2_START_AT + 1),
    settle: new SettleTracker(),
    boundaries,
    previousStatus: "working",
  });
  assert.equal(resolved.status, "blocked");
  assert.equal(resolved.extendDeadline, true);
});

test("a local command ends its turn on Orca and leaves herdr's status alone", async () => {
  // /compact writes only string user records and ends on its stdout record.
  const lifecycle = extractLifecycle(
    readFileSync(new URL("./agents/claude/__fixtures__/claude-compact.jsonl", import.meta.url), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as TranscriptRecord),
  );
  const settle = new SettleTracker();
  settle.observe(lifecycle);
  assert.equal(settle.settledByTranscript, true);

  // A stale "working" hint must not outlive the transcript's end.
  const resolved = await resolveStatus({
    evidence: hint("working", null),
    settle,
    boundaries: transcriptBoundaries(lifecycle),
    previousStatus: "working",
    readScreen: async () => assert.fail("a settled turn needs no screen"),
  });
  assert.deepEqual(resolved, { status: "idle", extendDeadline: false });

  for (const status of ["idle", "blocked"] as const) {
    const herdr = await resolveStatus({
      evidence: { kind: "classified", status },
      settle,
      boundaries: EMPTY_TRANSCRIPT_BOUNDARIES,
      previousStatus: "working",
    });
    assert.equal(herdr.status, status);
  }
});

test("without transcript boundaries, the Orca state hint is the fallback", async () => {
  for (const [state, expected] of [
    ["working", "working"],
    ["done", "idle"],
    ["waiting", "unknown"],
    [null, "unknown"],
  ] as const) {
    const resolved = await resolveStatus({
      evidence: hint(state, null),
      settle: new SettleTracker(),
      boundaries: EMPTY_TRANSCRIPT_BOUNDARIES,
      previousStatus: "blocked",
    });
    assert.equal(resolved.status, expected);
    assert.equal(resolved.extendDeadline, false);
  }
});

test("recent transcript reads are bounded and independent of the output offset", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cctag-transcript-tail-"));
  const path = join(directory, "session.jsonl");
  writeFileSync(
    path,
    Array.from({ length: 300 }, (_, id) => JSON.stringify({ id })).join("\n") + "\n" + '{"partial"',
  );
  try {
    const offsetRead = await readNewRecords(path, statSync(path).size);
    assert.equal(offsetRead.records.length, 0);

    const recent = await readRecentRecords(path);
    assert.equal(recent.length, 256);
    assert.equal(recent[0]?.id, 44);
    assert.equal(recent[255]?.id, 299);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("recent transcript reads handle cut records, exact record edges, and short files", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cctag-transcript-edges-"));
  const windowBytes = 256 * 1024;
  const cutPath = join(directory, "cut.jsonl");
  const edgePath = join(directory, "edge.jsonl");
  const shortPath = join(directory, "short.jsonl");
  try {
    const largeRecord = JSON.stringify({ id: "cut", padding: "x".repeat(windowBytes) });
    writeFileSync(cutPath, `${largeRecord}\n${JSON.stringify({ id: "after-cut" })}\n`);
    assert.deepEqual(await readRecentRecords(cutPath), [{ id: "after-cut" }]);

    const prefix = `${JSON.stringify({ id: "prefix" })}\n`;
    const edgeRecord = `${JSON.stringify({ id: "edge" })}\n`;
    writeFileSync(edgePath, prefix + edgeRecord + " ".repeat(windowBytes - edgeRecord.length));
    assert.deepEqual(await readRecentRecords(edgePath), [{ id: "edge" }]);

    writeFileSync(shortPath, `${JSON.stringify({ id: "short" })}\n`);
    assert.deepEqual(await readRecentRecords(shortPath), [{ id: "short" }]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("lifecycle baselines join multi-chunk records and leave partial tails readable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cctag-transcript-baseline-"));
  const path = join(directory, "session.jsonl");
  const started = JSON.stringify({ id: "start", type: "user" });
  const large = JSON.stringify({ id: "large", padding: "x".repeat(128 * 1024) });
  const partial = JSON.stringify({ id: "post-baseline" });
  const splitAt = Math.floor(partial.length / 2);
  const captured = `${started}\n${large}\n${partial.slice(0, splitAt)}`;
  writeFileSync(path, captured);
  try {
    const baseline = await readLastMatchingRecordBefore(path, statSync(path).size, (record) => record.id === "start");
    assert.ok(baseline);
    assert.deepEqual(baseline.record, JSON.parse(started));
    assert.equal(baseline.completeOffset, Buffer.byteLength(`${started}\n${large}\n`));

    writeFileSync(path, `${captured}${partial.slice(splitAt)}\n`);
    const tail = await readNewRecords(path, baseline.completeOffset);
    assert.deepEqual(tail.records, [JSON.parse(partial)]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("herdr's idle against a running turn is believed only once it lasts", () => {
  // Issue #47: a momentary idle mid-turn closed an adopted turn while its
  // transcript ended on a tool_use, with no end record.
  const t = new SettleTracker();
  t.observe([{ kind: "started", timestamp: 1 }]);
  assert.equal(t.effectiveStatus("idle", 1_000), "working");
  assert.equal(t.effectiveStatus("done", 1_000 + IDLE_AGAINST_RUNNING_GRACE_MS - 1), "working");
  assert.equal(t.effectiveStatus("idle", 1_000 + IDLE_AGAINST_RUNNING_GRACE_MS), "idle", "a turn that ends without a boundary still ends");
});

test("the idle grace restarts after any other status, and after a new start", () => {
  const t = new SettleTracker();
  t.markTurnRunning();
  assert.equal(t.effectiveStatus("idle", 0), "working");
  assert.equal(t.effectiveStatus("working", 10_000), "working");
  assert.equal(t.effectiveStatus("idle", IDLE_AGAINST_RUNNING_GRACE_MS), "working", "timed from the second idle, not the first");
  assert.equal(t.effectiveStatus("blocked", IDLE_AGAINST_RUNNING_GRACE_MS + 1), "blocked");
  t.observe([{ kind: "started", timestamp: 2 }]);
  assert.equal(t.effectiveStatus("idle", 2 * IDLE_AGAINST_RUNNING_GRACE_MS + 2), "working");
});

test("a turn the transcript has closed settles at once, with no grace", () => {
  const t = new SettleTracker();
  t.observe([{ kind: "started", timestamp: 1 }, { kind: "completed", timestamp: 2 }]);
  assert.equal(t.effectiveStatus("idle", 0), "idle");
  assert.equal(t.effectiveStatus("done", 0), "done");
});
