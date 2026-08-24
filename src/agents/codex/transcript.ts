import { closeSync, openSync, readdirSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { TurnLifecycleEvent } from "../driver.js";

const SESSIONS_ROOT = join(homedir(), ".codex", "sessions");

interface CodexContentBlock {
  type?: string;
  text?: string;
}

interface CodexPayload {
  type?: string;
  role?: string;
  name?: string;
  content?: CodexContentBlock[];
  cwd?: string;
  session_id?: string;
  turn_id?: string;
}

export interface CodexRecord {
  type?: string;
  payload?: CodexPayload;
}

/** Lists `~/.codex/sessions/YYYY/MM/DD` day directories, most recent first. */
function listDayDirsNewestFirst(maxDays = 30): string[] {
  const dirs: string[] = [];
  try {
    const years = readdirSync(SESSIONS_ROOT)
      .filter((y) => /^\d{4}$/.test(y))
      .sort()
      .reverse();
    for (const y of years) {
      if (dirs.length >= maxDays) break;
      const yDir = join(SESSIONS_ROOT, y);
      const months = readdirSync(yDir)
        .filter((m) => /^\d{2}$/.test(m))
        .sort()
        .reverse();
      for (const m of months) {
        if (dirs.length >= maxDays) break;
        const mDir = join(yDir, m);
        const days = readdirSync(mDir)
          .filter((d) => /^\d{2}$/.test(d))
          .sort()
          .reverse();
        for (const d of days) {
          if (dirs.length >= maxDays) break;
          dirs.push(join(mDir, d));
        }
      }
    }
  } catch {
    // sessions dir may not exist yet
  }
  return dirs;
}

const FIRST_LINE_CHUNK = 16 * 1024;
const FIRST_LINE_MAX = 1024 * 1024; // session_meta embeds Codex's full system
// prompt (`base_instructions`) inline, which alone can run well past 16KB —
// grow the read in chunks instead of a single fixed-size read (verified
// empirically: a flat 4KB read truncates mid-string and fails to parse).
// Still far cheaper than reading a whole (potentially multi-MB) transcript.

/** Reads just enough of a rollout file's first line to pull its
 *  session_meta.cwd, without loading the whole transcript into memory. */
function firstLineCwd(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    let size = FIRST_LINE_CHUNK;
    while (size <= FIRST_LINE_MAX) {
      const buf = Buffer.alloc(size);
      const bytesRead = readSync(fd, buf, 0, buf.length, 0);
      const text = buf.toString("utf8", 0, bytesRead);
      const nl = text.indexOf("\n");
      if (nl !== -1 || bytesRead < size) {
        // Found a complete line, or hit EOF before filling the buffer.
        const firstLine = nl === -1 ? text : text.slice(0, nl);
        if (!firstLine.trim()) return null;
        const rec = JSON.parse(firstLine) as CodexRecord;
        return rec.payload?.cwd ?? null;
      }
      size *= 2;
    }
    return null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * Locates a Codex CLI session's rollout JSONL file.
 *
 * Preferred path: if herdr reported a session id (requires the user to have
 * trusted the `herdr-agent-state.sh` SessionStart hook — a one-time Codex
 * prompt; herdr can't report a session id until then), the id is embedded
 * verbatim as the filename's trailing UUID
 * (`rollout-<timestamp>-<session-id>.jsonl`), so this is an exact, cheap
 * (readdir-only) lookup.
 *
 * Fallback (session id unavailable): scan day directories newest-first for
 * the most recent rollout file whose `session_meta.payload.cwd` matches the
 * pane's cwd. This can misattribute if two Codex sessions are running
 * concurrently in the exact same directory, but that's an acceptable v1
 * trade-off — cctag typically pairs one terminal per project directory.
 */
export function locateCodexTranscript(cwd: string, sessionId: string | null): string | null {
  const dayDirs = listDayDirsNewestFirst();

  if (sessionId) {
    const suffix = `-${sessionId}.jsonl`;
    for (const dir of dayDirs) {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      const hit = names.find((n) => n.endsWith(suffix));
      if (hit) return join(dir, hit);
    }
    return null;
  }

  for (const dir of dayDirs) {
    let names: string[];
    try {
      names = readdirSync(dir).filter((n) => n.startsWith("rollout-") && n.endsWith(".jsonl"));
    } catch {
      continue;
    }
    names.sort().reverse(); // filenames embed an ISO timestamp — lexicographic sort is newest-first
    for (const name of names) {
      const p = join(dir, name);
      if (firstLineCwd(p) === cwd) return p;
    }
  }
  return null;
}

/**
 * Assistant text lives in `response_item` records with `payload.type ===
 * "message"` and `payload.role === "assistant"` — deliberately NOT the
 * parallel `event_msg`/`agent_message` records, which were verified
 * empirically to duplicate the same text (using both would double-post to
 * Slack). Tool calls are `custom_tool_call`/`function_call` records; their
 * `payload.name` is the tool name. `reasoning` records (chain-of-thought)
 * are intentionally ignored — they match neither branch.
 */
export function extractCodexTurnOutput(records: CodexRecord[]): { texts: string[]; toolNames: string[] } {
  const texts: string[] = [];
  const toolNames: string[] = [];
  for (const r of records) {
    if (r.type !== "response_item" || !r.payload) continue;
    const p = r.payload;
    if (p.type === "message" && p.role === "assistant" && Array.isArray(p.content)) {
      for (const block of p.content) {
        if (block?.type === "output_text" && block.text) texts.push(block.text);
      }
    } else if ((p.type === "custom_tool_call" || p.type === "function_call") && p.name) {
      toolNames.push(p.name);
    }
  }
  return { texts, toolNames };
}

/**
 * Turn boundaries in a Codex rollout.
 *
 * Codex states these outright, which makes it the easier of the two formats:
 * `event_msg` records carry `task_started` and `task_complete` (with `turn_id`,
 * `duration_ms`, `completed_at`), plus `turn_aborted` for an interrupted turn.
 * Measured across 86 local rollouts: 46 starts against 45 completes and 1
 * abort — exactly one end per start.
 *
 * These are the only `event_msg` records read. The rest are deliberately
 * ignored, `agent_message` above all: extractCodexTurnOutput takes assistant
 * text from `response_item` records because `event_msg`/`agent_message`
 * duplicates it, and reading both double-posts to Slack.
 */
export function extractCodexLifecycle(records: CodexRecord[]): TurnLifecycleEvent[] {
  const events: TurnLifecycleEvent[] = [];
  for (const r of records) {
    if (r.type !== "event_msg" || !r.payload) continue;
    const { type, turn_id: turnId } = r.payload;
    if (type === "task_started") events.push({ kind: "started", turnId });
    else if (type === "task_complete") events.push({ kind: "completed", turnId });
    else if (type === "turn_aborted") events.push({ kind: "aborted", turnId });
  }
  return events;
}
