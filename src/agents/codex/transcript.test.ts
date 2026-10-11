import { test } from "node:test";
import assert from "node:assert/strict";
import { extractCodexLifecycle } from "./transcript.js";

test("Codex task_started/task_complete carry their turn id and rollout timestamp", () => {
  const startedAt = "2026-09-27T14:57:34.182Z";
  const completedAt = "2026-09-27T14:59:17.243Z";
  const events = extractCodexLifecycle([
    { type: "event_msg", timestamp: startedAt, payload: { type: "task_started", turn_id: "T1" } },
    { type: "event_msg", timestamp: completedAt, payload: { type: "task_complete", turn_id: "T1" } },
  ]);
  assert.deepEqual(events, [
    { kind: "started", turnId: "T1", timestamp: Date.parse(startedAt) },
    { kind: "completed", turnId: "T1", timestamp: Date.parse(completedAt) },
  ]);
});

test("Codex turn_aborted carries its rollout timestamp", () => {
  const timestamp = "2026-09-27T14:57:59.448Z";
  assert.deepEqual(
    extractCodexLifecycle([
      { type: "event_msg", timestamp, payload: { type: "turn_aborted", turn_id: "T2" } },
    ]),
    [{ kind: "aborted", turnId: "T2", timestamp: Date.parse(timestamp) }],
  );
});

test("Codex boundaries with missing or invalid timestamps retain their event kinds", () => {
  assert.deepEqual(extractCodexLifecycle([
    { type: "event_msg", payload: { type: "task_started", turn_id: "T1" } },
    { type: "event_msg", timestamp: "not a timestamp", payload: { type: "task_complete", turn_id: "T1" } },
    { type: "event_msg", payload: { type: "turn_aborted", turn_id: "T2" } },
  ]), [
    { kind: "started", turnId: "T1", timestamp: null },
    { kind: "completed", turnId: "T1", timestamp: null },
    { kind: "aborted", turnId: "T2", timestamp: null },
  ]);
});

test("Codex agent_message is not a boundary", () => {
  // It duplicates assistant text that extractCodexTurnOutput already reads from
  // response_item records — reading it here would be noise, and reading it
  // there would double-post.
  assert.deepEqual(
    extractCodexLifecycle([
      { type: "event_msg", timestamp: "2026-09-27T14:57:34.665Z", payload: { type: "agent_message" } },
      { type: "event_msg", timestamp: "2026-09-27T14:57:35.470Z", payload: { type: "token_count" } },
      { type: "response_item", timestamp: "2026-09-27T14:57:37.792Z", payload: { type: "message", role: "assistant" } },
    ]),
    [],
  );
});
