import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { extractOmpLifecycle, extractOmpTurnOutput } from "./transcript.js";

function fixtureRecords(): unknown[] {
  return readFileSync(new URL("./__fixtures__/transcript-lifecycle.jsonl", import.meta.url), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as unknown);
}

test("OMP v3 transcript boundaries follow message roles and stopReason", () => {
  const records = fixtureRecords();
  const events = extractOmpLifecycle(records);

  assert.deepEqual(
    events.map(({ kind }) => kind),
    ["started", "completed", "started", "aborted", "started", "completed"],
  );
  assert.deepEqual(events.map(({ timestamp }) => timestamp), [
    Date.parse("2026-09-28T15:23:49.291Z"),
    Date.parse("2026-09-28T15:23:54.689Z"),
    Date.parse("2026-09-28T15:27:15.263Z"),
    Date.parse("2026-09-28T15:28:17.096Z"),
    Date.parse("2026-09-28T15:29:25.318Z"),
    Date.parse("2026-09-28T15:29:28.646Z"),
  ]);

  const nonBoundaries = [records[2], records[3], records[4], records[7], records[8], records[9], records[13]];
  assert.deepEqual(extractOmpLifecycle(nonBoundaries), []);
});

test("OMP output reads assistant text, toolCall names, and toolResult outcomes only", () => {
  const output = extractOmpTurnOutput(fixtureRecords());

  assert.deepEqual(output.texts, ["<task-content>", "<task-content>"]);
  assert.deepEqual(output.toolNames, ["bash", "ask"]);
  assert.deepEqual(output.toolOutcomes, [
    { toolUseId: "<tool-call-A>", ok: true },
    { toolUseId: "<tool-call-D>", ok: false },
  ]);
});

test("unknown OMP stop reasons and session_exit are not turn boundaries", () => {
  assert.deepEqual(
    extractOmpLifecycle([
      { type: "message", timestamp: "2026-09-28T15:00:00Z", message: { role: "assistant", stopReason: "yield" } },
      { type: "custom", customType: "session_exit", timestamp: "2026-09-28T15:00:01Z" },
      { type: "custom", customType: "tool_execution_start", timestamp: "2026-09-28T15:00:02Z" },
    ]),
    [],
  );
});

test("unreadable OMP boundary timestamps retain the event with null time", () => {
  assert.deepEqual(
    extractOmpLifecycle([
      { type: "message", timestamp: "not a timestamp", message: { role: "assistant", stopReason: "stop" } },
      { type: "message", timestamp: { toString: () => { throw new Error("must not coerce timestamp"); } }, message: { role: "user" } },
      { type: "message", message: { role: "assistant", stopReason: "aborted" } },
    ]),
    [
      { kind: "completed", timestamp: null },
      { kind: "started", timestamp: null },
      { kind: "aborted", timestamp: null },
    ],
  );
});
