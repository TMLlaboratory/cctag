import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractSendUserFileRequests,
  extractToolOutcomes,
  readPendingQuestions,
  type TranscriptRecord,
} from "./transcript.js";

function assistantToolUse(id: string, name: string, input: unknown): TranscriptRecord {
  return { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } };
}

function toolResult(toolUseId: string, isError?: boolean): TranscriptRecord {
  const block: Record<string, unknown> = { type: "tool_result", tool_use_id: toolUseId, content: "..." };
  if (isError !== undefined) block.is_error = isError;
  return { type: "user", message: { role: "user", content: [block] } };
}

test("extractToolOutcomes treats a denied tool as failed and everything else as ok", () => {
  // Verified against real transcripts: a denied permission prompt records
  // is_error: true, a successful tool either omits the field or sets it false.
  const records = [toolResult("toolu_denied", true), toolResult("toolu_ok_explicit", false), toolResult("toolu_ok_absent")];
  assert.deepEqual(extractToolOutcomes(records), [
    { toolUseId: "toolu_denied", ok: false },
    { toolUseId: "toolu_ok_explicit", ok: true },
    { toolUseId: "toolu_ok_absent", ok: true },
  ]);
});

test("extractSendUserFileRequests reads every path and the caption from one call", () => {
  const records = [
    assistantToolUse("toolu_s", "SendUserFile", {
      files: ["reports/out.pdf", "results/data.csv"],
      caption: "報告書と数値",
      status: "normal",
    }),
  ];
  assert.deepEqual(extractSendUserFileRequests(records), [
    { toolUseId: "toolu_s", paths: ["reports/out.pdf", "results/data.csv"], caption: "報告書と数値" },
  ]);
});

test("extractSendUserFileRequests drops non-string and empty entries from files", () => {
  const records = [assistantToolUse("toolu_s", "SendUserFile", { files: ["ok.png", "", 42, null] })];
  assert.deepEqual(extractSendUserFileRequests(records), [
    { toolUseId: "toolu_s", paths: ["ok.png"], caption: undefined },
  ]);
});

test("extractSendUserFileRequests ignores a call naming no usable file", () => {
  assert.deepEqual(extractSendUserFileRequests([assistantToolUse("toolu_s", "SendUserFile", { files: [] })]), []);
});

test("a denied SendUserFile uploads nothing", async () => {
  const { WrittenFileTracker } = await import("../../attachments.js");
  const tracker = new WrittenFileTracker();
  // Same hazard as the denied Write: the human refused, so nothing may leave.
  const records = [
    assistantToolUse("toolu_d", "SendUserFile", { files: ["/secrets/salaries.csv"], caption: "給与" }),
    toolResult("toolu_d", true),
  ];
  tracker.ingest({ sendFileRequests: extractSendUserFileRequests(records), toolOutcomes: extractToolOutcomes(records) });
  assert.deepEqual(tracker.paths(), []);
});

test("a confirmed SendUserFile yields one flat entry per file, each carrying the caption", async () => {
  const { WrittenFileTracker } = await import("../../attachments.js");
  const tracker = new WrittenFileTracker();
  const records = [
    assistantToolUse("toolu_m", "SendUserFile", { files: ["a.pdf", "b.csv"], caption: "二件" }),
    toolResult("toolu_m"),
  ];
  tracker.ingest({ sendFileRequests: extractSendUserFileRequests(records), toolOutcomes: extractToolOutcomes(records) });
  // Flat, not grouped by tool use — the size and count caps downstream count entries.
  assert.deepEqual(tracker.paths(), [
    { path: "a.pdf", caption: "二件" },
    { path: "b.csv", caption: "二件" },
  ]);
});

test("a SendUserFile whose outcome never arrived stays out", async () => {
  const { WrittenFileTracker } = await import("../../attachments.js");
  const tracker = new WrittenFileTracker();
  const records = [assistantToolUse("toolu_n", "SendUserFile", { files: ["pending.png"] })];
  tracker.ingest({ sendFileRequests: extractSendUserFileRequests(records), toolOutcomes: extractToolOutcomes(records) });
  assert.deepEqual(tracker.paths(), []);
});


test("a SendUserFile confirmed in a later poll batch still counts", async () => {
  const { WrittenFileTracker } = await import("../../attachments.js");
  const tracker = new WrittenFileTracker();
  // The request and its outcome routinely arrive in different batches, which is
  // why the tracker has to be stateful rather than a per-batch filter.
  const request = [assistantToolUse("toolu_late", "SendUserFile", { files: ["/out/late.csv"] })];
  tracker.ingest({ sendFileRequests: extractSendUserFileRequests(request), toolOutcomes: [] });
  assert.deepEqual(tracker.paths(), [], "not yet confirmed");
  tracker.ingest({ toolOutcomes: extractToolOutcomes([toolResult("toolu_late")]) });
  assert.deepEqual(tracker.paths(), [{ path: "/out/late.csv", caption: undefined }]);
});

test("the same path sent twice uploads once and keeps the first caption", async () => {
  const { WrittenFileTracker } = await import("../../attachments.js");
  const tracker = new WrittenFileTracker();
  for (const [id, caption] of [["toolu_a", "一回目"], ["toolu_b", "二回目"]]) {
    const recs = [assistantToolUse(id, "SendUserFile", { files: ["/out/same.md"], caption }), toolResult(id)];
    tracker.ingest({ sendFileRequests: extractSendUserFileRequests(recs), toolOutcomes: extractToolOutcomes(recs) });
  }
  assert.deepEqual(tracker.paths(), [{ path: "/out/same.md", caption: "一回目" }]);
});

// --- readPendingQuestions ---------------------------------------------------
// The screen was the wrong source for this: option previews, several questions
// and terminal width each change the layout, and the shape that broke the pane
// parser in production is the one exercised below.

function writeTranscript(dir: string, lines: unknown[]): string {
  const p = join(dir, "session.jsonl");
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return p;
}

const askUse = (id: string, questions: unknown[]) => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "tool_use", id, name: "AskUserQuestion", input: { questions } }] },
});
const result = (id: string) => ({
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
});

const TWO_QUESTIONS = [
  {
    header: "除外回の表し方",
    question: "どう持ちますか？",
    multiSelect: false,
    options: [
      { label: "lessonとして作りフラグを立てる（推奨）", preview: "【学生の画面】…" },
      { label: "lessonを作らない（番号が飛ぶ）", preview: "…" },
    ],
  },
  {
    header: "実装スコープ",
    question: "どこまで含めますか？",
    multiSelect: false,
    options: [{ label: "公開日時まで（推奨）" }, { label: "全部" }],
  },
];

test("a pending question is returned with every field the screen could not give", () => {
  const dir = mkdtempSync(join(tmpdir(), "cctag-pq-"));
  try {
    const p = writeTranscript(dir, [askUse("tu_1", TWO_QUESTIONS)]);
    const pq = readPendingQuestions(p);
    assert.ok(pq, "the pending question must be found");
    assert.equal(pq.toolUseId, "tu_1");
    assert.equal(pq.questions.length, 2, "several questions is the case that broke the pane parser");
    assert.equal(pq.questions[0].header, "除外回の表し方");
    assert.deepEqual(
      pq.questions[0].options.map((o) => o.label),
      ["lessonとして作りフラグを立てる（推奨）", "lessonを作らない（番号が飛ぶ）"],
      "labels come through whole, not wrapped across lines as the pane showed them",
    );
    assert.equal(pq.questions[1].options.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an answered question is not reported as pending", () => {
  // What makes this usable as a trigger at all: the tool_use is written when the
  // question appears (measured 4h11m before its result on a real session), so
  // presence alone would report long-resolved questions forever.
  const dir = mkdtempSync(join(tmpdir(), "cctag-pq-"));
  try {
    const p = writeTranscript(dir, [askUse("tu_1", TWO_QUESTIONS), result("tu_1")]);
    assert.equal(readPendingQuestions(p), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the newest question wins when an older one was already answered", () => {
  const dir = mkdtempSync(join(tmpdir(), "cctag-pq-"));
  try {
    const p = writeTranscript(dir, [
      askUse("tu_old", [{ header: "古い", question: "?", options: [{ label: "a" }] }]),
      result("tu_old"),
      askUse("tu_new", [{ header: "新しい", question: "?", options: [{ label: "b" }] }]),
    ]);
    const pq = readPendingQuestions(p);
    assert.equal(pq?.toolUseId, "tu_new");
    assert.equal(pq?.questions[0].header, "新しい");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("malformed model output is dropped rather than half-rendered", () => {
  // `input` is raw model output, so nothing about its shape is guaranteed.
  const dir = mkdtempSync(join(tmpdir(), "cctag-pq-"));
  try {
    const p = writeTranscript(dir, [
      askUse("tu_1", [
        { header: "no options", question: "?", options: [] },
        { header: "no question", options: [{ label: "x" }] },
        { question: "header defaults", options: [{ label: "y" }, { label: 42 }] },
      ]),
    ]);
    const pq = readPendingQuestions(p);
    assert.equal(pq?.questions.length, 1, "only the usable question survives");
    assert.equal(pq?.questions[0].header, "質問", "a missing header falls back rather than rendering undefined");
    assert.deepEqual(pq?.questions[0].options.map((o) => o.label), ["y"], "the non-string label is dropped");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing or unreadable transcript yields null, not a throw", () => {
  assert.equal(readPendingQuestions(join(tmpdir(), "cctag-does-not-exist", "x.jsonl")), null);
});
