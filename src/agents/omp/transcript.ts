import type { ToolOutcome, TurnLifecycleEvent } from "../driver.js";

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  try {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : null;
  } catch {
    return null;
  }
}

export function extractOmpLifecycle(records: unknown[]): TurnLifecycleEvent[] {
  const events: TurnLifecycleEvent[] = [];
  for (const value of records) {
    const entry = record(value);
    if (entry?.type !== "message") continue;
    const message = record(entry.message);
    if (!message) continue;

    if (message.role === "user") {
      events.push({ kind: "started", timestamp: parseTimestamp(entry.timestamp) });
    } else if (message.role === "assistant") {
      if (message.stopReason === "stop") {
        events.push({ kind: "completed", timestamp: parseTimestamp(entry.timestamp) });
      } else if (message.stopReason === "aborted") {
        events.push({ kind: "aborted", timestamp: parseTimestamp(entry.timestamp) });
      }
    }
  }
  return events;
}

export function extractOmpTurnOutput(records: unknown[]): {
  texts: string[];
  toolNames: string[];
  toolOutcomes: ToolOutcome[];
} {
  const texts: string[] = [];
  const toolNames: string[] = [];
  const toolOutcomes: ToolOutcome[] = [];

  for (const value of records) {
    const entry = record(value);
    if (entry?.type !== "message") continue;
    const message = record(entry.message);
    if (!message) continue;

    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const value of message.content) {
        const block = record(value);
        if (!block) continue;
        if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
          texts.push(block.text);
        } else if (block.type === "toolCall" && typeof block.name === "string" && block.name.length > 0) {
          toolNames.push(block.name);
        }
      }
    } else if (message.role === "toolResult" && typeof message.toolCallId === "string" && message.toolCallId.length > 0) {
      toolOutcomes.push({ toolUseId: message.toolCallId, ok: message.isError !== true });
    }
  }

  return { texts, toolNames, toolOutcomes };
}
