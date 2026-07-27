import { test } from "node:test";
import assert from "node:assert/strict";
import { extractToolOutcomes, extractWriteRequests, type TranscriptRecord } from "./transcript.js";

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
  assert.deepEqual(tracker.paths(), ["/out/diagram.svg"]);
});
