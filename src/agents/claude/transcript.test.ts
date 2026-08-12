import { test } from "node:test";
import assert from "node:assert/strict";
import { extractSendUserFileRequests, extractToolOutcomes, type TranscriptRecord } from "./transcript.js";

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

