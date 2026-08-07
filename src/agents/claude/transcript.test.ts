import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractSendUserFileRequests,
  extractToolOutcomes,
  extractWriteRequests,
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

test("extractWriteRequests pairs Write targets with their tool-use ids", () => {
  const records = [
    assistantToolUse("toolu_1", "Write", { file_path: "/out/a.png", content: "..." }),
    assistantToolUse("toolu_2", "Read", { file_path: "/out/b.png" }),
    assistantToolUse("toolu_3", "Bash", { command: "ls" }),
  ];
  assert.deepEqual(extractWriteRequests(records), [{ toolUseId: "toolu_1", path: "/out/a.png" }]);
});

test("extractWriteRequests ignores a Write with no usable file_path", () => {
  const records = [assistantToolUse("toolu_1", "Write", { content: "no path" }), assistantToolUse("toolu_2", "Write", { file_path: "" })];
  assert.deepEqual(extractWriteRequests(records), []);
});

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

test("a denied Write to an existing file never becomes an upload candidate", async () => {
  const { WrittenFileTracker } = await import("../../attachments.js");
  const tracker = new WrittenFileTracker();
  // The exact scenario from review: Claude asks to overwrite an existing
  // sensitive file, the human says no, the file is untouched on disk.
  const records = [assistantToolUse("toolu_x", "Write", { file_path: "/secrets/report.pdf" }), toolResult("toolu_x", true)];
  tracker.ingest({ writeRequests: extractWriteRequests(records), toolOutcomes: extractToolOutcomes(records) });
  assert.deepEqual(tracker.paths(), []);
});

test("an approved Write does become an upload candidate", async () => {
  const { WrittenFileTracker } = await import("../../attachments.js");
  const tracker = new WrittenFileTracker();
  const records = [assistantToolUse("toolu_y", "Write", { file_path: "/out/diagram.svg" }), toolResult("toolu_y")];
  tracker.ingest({ writeRequests: extractWriteRequests(records), toolOutcomes: extractToolOutcomes(records) });
  assert.deepEqual(tracker.paths(), [{ path: "/out/diagram.svg", origin: "write" }]);
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
    { path: "a.pdf", origin: "send", caption: "二件" },
    { path: "b.csv", origin: "send", caption: "二件" },
  ]);
});

test("a SendUserFile whose outcome never arrived stays out", async () => {
  const { WrittenFileTracker } = await import("../../attachments.js");
  const tracker = new WrittenFileTracker();
  const records = [assistantToolUse("toolu_n", "SendUserFile", { files: ["pending.png"] })];
  tracker.ingest({ sendFileRequests: extractSendUserFileRequests(records), toolOutcomes: extractToolOutcomes(records) });
  assert.deepEqual(tracker.paths(), []);
});

test("SendUserFile supersedes a Write of the same path, so the caption survives", async () => {
  const { WrittenFileTracker } = await import("../../attachments.js");
  const tracker = new WrittenFileTracker();
  // The common sequence: the agent writes a chart, then sends it. The send is
  // the entry carrying intent, and it must win regardless of arrival order.
  const written = [assistantToolUse("toolu_w", "Write", { file_path: "/out/chart.png" }), toolResult("toolu_w")];
  tracker.ingest({ writeRequests: extractWriteRequests(written), toolOutcomes: extractToolOutcomes(written) });
  const sent = [
    assistantToolUse("toolu_s2", "SendUserFile", { files: ["/out/chart.png"], caption: "売上推移" }),
    toolResult("toolu_s2"),
  ];
  tracker.ingest({ sendFileRequests: extractSendUserFileRequests(sent), toolOutcomes: extractToolOutcomes(sent) });
  assert.deepEqual(tracker.paths(), [{ path: "/out/chart.png", origin: "send", caption: "売上推移" }]);
});

test("a Write does not overwrite an existing SendUserFile entry for the same path", async () => {
  const { WrittenFileTracker } = await import("../../attachments.js");
  const tracker = new WrittenFileTracker();
  const sent = [
    assistantToolUse("toolu_s3", "SendUserFile", { files: ["/out/chart.png"], caption: "先に送信" }),
    toolResult("toolu_s3"),
  ];
  tracker.ingest({ sendFileRequests: extractSendUserFileRequests(sent), toolOutcomes: extractToolOutcomes(sent) });
  const written = [assistantToolUse("toolu_w2", "Write", { file_path: "/out/chart.png" }), toolResult("toolu_w2")];
  tracker.ingest({ writeRequests: extractWriteRequests(written), toolOutcomes: extractToolOutcomes(written) });
  assert.deepEqual(tracker.paths(), [{ path: "/out/chart.png", origin: "send", caption: "先に送信" }]);
});
