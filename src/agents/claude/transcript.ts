import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SendFileRequest, ToolOutcome, TurnLifecycleEvent } from "../driver.js";

// Claude Code encodes the project cwd into the transcript directory name by
// replacing every non-alphanumeric character with "-". Verified empirically
// (Phase 0): "/private/tmp/cctag-scratch" -> "-private-tmp-cctag-scratch".
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export function transcriptPath(cwd: string, sessionId: string): string {
  return join(homedir(), ".claude", "projects", encodeCwd(cwd), `${sessionId}.jsonl`);
}

/**
 * Locates a Claude Code session's transcript.
 *
 * Preferred path: herdr reported a session id (via the `herdr-agent-state.sh`
 * SessionStart hook), so the file is an exact join — no scanning needed.
 *
 * Fallback (session id unavailable — e.g. the hook never fired: not yet
 * trusted, or something on PATH intercepted the `python3` it shells out to):
 * every session for this cwd lands in one directory (Claude Code encodes cwd,
 * not session id, into the directory name), so the newest `*.jsonl` file in
 * it is the one this pane is almost certainly writing to. Mirrors the same
 * fallback `locateCodexTranscript` already does for Codex CLI
 * (agents/codex/transcript.ts) — Claude Code just doesn't need a
 * cwd-matching scan across day directories since the directory is already
 * cwd-scoped.
 */
export function locateClaudeTranscript(cwd: string, sessionId: string | null): string | null {
  if (sessionId) return transcriptPath(cwd, sessionId);

  const dir = join(homedir(), ".claude", "projects", encodeCwd(cwd));
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return null;
  }

  let newest: { path: string; mtimeMs: number } | null = null;
  for (const name of names) {
    const p = join(dir, name);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(p).mtimeMs;
    } catch {
      continue;
    }
    if (!newest || mtimeMs > newest.mtimeMs) newest = { path: p, mtimeMs };
  }
  return newest?.path ?? null;
}

interface ContentBlock {
  type: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  text?: string;
  content?: unknown;
}

export interface TranscriptRecord {
  type?: string;
  subtype?: string;
  uuid?: string;
  timestamp?: string;
  isSidechain?: boolean;
  message?: { role?: string; content?: unknown; stop_reason?: string | null };
}

function contentBlocks(record: TranscriptRecord): ContentBlock[] {
  const content = record.message?.content;
  if (Array.isArray(content)) return content as ContentBlock[];
  return [];
}

/** Concatenates all assistant text blocks in the given records, in order. */
export function extractAssistantText(records: TranscriptRecord[]): string[] {
  const texts: string[] = [];
  for (const r of records) {
    if (r.type !== "assistant") continue;
    for (const block of contentBlocks(r)) {
      if (block.type === "text" && block.text) texts.push(block.text);
    }
  }
  return texts;
}

/**
 * `SendUserFile` calls the assistant made — the agent saying outright which
 * files it wants delivered. This is the only outbound transcript signal cctag
 * reads; inferring intent from `Write` calls was tried and removed.
 *
 * Verified against a live pane: the tool is absent in `claude -p` (headless)
 * but present in the interactive TUI cctag drives, and a successful call
 * records `input: { files: [...], caption, status }` plus a `tool_result`
 * naming each delivered file. Only `input.files` is read — the result text
 * carries absolute paths but in an undocumented human-readable format, so the
 * relative paths are resolved against the pane's cwd instead (the result is
 * used only for its success/failure bit, via extractToolOutcomes).
 *
 * Non-string and empty entries are dropped rather than trusted: `files` comes
 * straight from model output.
 */
export function extractSendUserFileRequests(records: TranscriptRecord[]): SendFileRequest[] {
  const requests: SendFileRequest[] = [];
  for (const r of records) {
    if (r.type !== "assistant") continue;
    for (const block of contentBlocks(r)) {
      if (block.type !== "tool_use" || block.name !== "SendUserFile" || !block.id) continue;
      const input = block.input as { files?: unknown; caption?: unknown } | undefined;
      const raw = Array.isArray(input?.files) ? input.files : [];
      const paths = raw.filter((p): p is string => typeof p === "string" && p.length > 0);
      if (paths.length === 0) continue;
      const caption = typeof input?.caption === "string" && input.caption.trim() ? input.caption.trim() : undefined;
      requests.push({ toolUseId: block.id, paths, caption });
    }
  }
  return requests;
}

/**
 * Outcomes of tool uses, read off the `tool_result` blocks Claude Code writes
 * back as `user` records.
 *
 * `is_error: true` is the failure signal, verified empirically by declining a
 * real permission prompt: the result records `is_error: true` with "The user
 * doesn't want to proceed with this tool use". Successful results either omit
 * the field or set it to false, so anything not explicitly true counts as
 * success.
 */
export function extractToolOutcomes(records: TranscriptRecord[]): ToolOutcome[] {
  const outcomes: ToolOutcome[] = [];
  for (const r of records) {
    for (const block of contentBlocks(r)) {
      if (block.type !== "tool_result" || !block.tool_use_id) continue;
      outcomes.push({ toolUseId: block.tool_use_id, ok: block.is_error !== true });
    }
  }
  return outcomes;
}

/** Response-level stop reasons that mean the model's turn ended rather than
 *  pausing for a tool. `tool_use` and `null` (an interrupted response) are the
 *  ones that must NOT count. */
const TERMINAL_STOP_REASONS = new Set(["end_turn", "stop_sequence", "max_tokens", "refusal"]);

/**
 * Turn boundaries in a Claude Code transcript.
 *
 * The authoritative end-of-turn record is `{type: "system", subtype:
 * "turn_duration"}`, which the CLI writes once per completed turn as that
 * turn's last record — measured across 286 local transcripts (366 occurrences,
 * carrying `durationMs`). It is preferred because it reports that *the harness*
 * finished, not merely that one API response ended.
 *
 * `stop_reason` is kept as a fallback for transcripts written before
 * `turn_duration` existed. It is a sound boundary but not a one-per-turn one: a
 * single API response is split into one record per content block and every
 * block carries the response's `stop_reason`, so a reply with a thinking block
 * and a text block yields two `end_turn` records (measured: 508 `end_turn`
 * against 366 `turn_duration` in the same sample). That is harmless here —
 * SettleTracker only needs to know a boundary was crossed, and crossing it
 * twice reads the same as once. What matters is that it never fires *mid*-turn:
 * a text block emitted alongside tool calls is stamped `tool_use`, not
 * `end_turn`, because the stamp belongs to the response rather than the block.
 *
 * A start is a genuine user record — content that is a plain string, or blocks
 * with no `tool_result` among them. Tool results come back as `user` records
 * too, and treating those as starts would re-arm the tracker on every tool call
 * in the turn.
 *
 * Sidechain records (subagent transcripts) are skipped: their turns are not the
 * pane's turn, and letting them arm or settle the tracker would report a
 * subagent's completion as the pane's.
 */
export function extractLifecycle(records: TranscriptRecord[]): TurnLifecycleEvent[] {
  const events: TurnLifecycleEvent[] = [];
  for (const r of records) {
    if (r.isSidechain === true) continue;
    if (r.type === "system" && r.subtype === "turn_duration") {
      events.push({ kind: "completed" });
      continue;
    }
    if (r.type === "assistant") {
      const stop = r.message?.stop_reason;
      if (typeof stop === "string" && TERMINAL_STOP_REASONS.has(stop)) events.push({ kind: "completed" });
      continue;
    }
    if (r.type === "user") {
      const content = r.message?.content;
      if (typeof content === "string") {
        events.push({ kind: "started" });
      } else if (Array.isArray(content)) {
        const isToolResult = (content as ContentBlock[]).some((b) => b?.type === "tool_result");
        if (!isToolResult) events.push({ kind: "started" });
      }
    }
  }
  return events;
}

/** Human-readable one-line summaries of tool_use blocks, in order (for the status line). */
export function extractToolUseSummaries(records: TranscriptRecord[]): string[] {
  const summaries: string[] = [];
  for (const r of records) {
    if (r.type !== "assistant") continue;
    for (const block of contentBlocks(r)) {
      if (block.type !== "tool_use" || !block.name) continue;
      if (block.name === "AskUserQuestion") continue; // handled separately
      summaries.push(block.name);
    }
  }
  return summaries;
}
