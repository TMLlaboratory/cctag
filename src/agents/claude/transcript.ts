import { closeSync, fstatSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SendFileRequest, ToolOutcome } from "../driver.js";

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

/**
 * The AskUserQuestion currently waiting for an answer, read from the transcript
 * instead of the screen — or null if none is pending.
 *
 * This exists because the screen is the wrong source for this. Claude Code
 * renders AskUserQuestion several different ways depending on the tool input:
 * option previews switch it to a side-by-side layout where labels wrap and box
 * art shares their lines, several questions add a tab bar, and the free-text row
 * is "Chat about this" in that renderer instead of a numbered "Type something".
 * Any of those defeats a line-oriented parser, and the layout also shifts with
 * terminal width. The transcript has the same content as structured JSON, so
 * none of that matters.
 *
 * Availability is verified, and is not symmetric across prompt kinds: the
 * `tool_use` for a question is written when the question *appears*, measured at
 * 4h11m before its `tool_result` on a real session that sat unanswered. A
 * permission prompt is the opposite — while one is on screen the pending
 * `tool_use` is absent entirely (601 tool uses, 0 without a result, measured on
 * a pane blocked at a Bash approval), so permission prompts still have to be
 * read off the pane.
 *
 * Only the file's tail is read: transcripts reach tens of MB, and a pending
 * question is by definition near the end (the agent is blocked behind it). A
 * cut-off first line fails to parse and is skipped, like any malformed line.
 */
export interface PendingQuestion {
  header: string;
  question: string;
  multiSelect: boolean;
  options: { label: string; description?: string }[];
}

export interface PendingQuestions {
  toolUseId: string;
  questions: PendingQuestion[];
}

export function readPendingQuestions(transcriptPath: string, tailBytes = 1_048_576): PendingQuestions | null {
  let fd: number;
  try {
    fd = openSync(transcriptPath, "r");
  } catch {
    return null;
  }
  let text: string;
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - tailBytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    text = buf.toString("utf8");
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }

  const answered = new Set<string>();
  let latest: PendingQuestions | null = null;
  for (const line of text.split("\n")) {
    if (!line.includes('"tool_use"') && !line.includes('"tool_result"')) continue;
    let rec: TranscriptRecord;
    try {
      rec = JSON.parse(line) as TranscriptRecord;
    } catch {
      continue;
    }
    for (const block of contentBlocks(rec)) {
      if (block.type === "tool_result" && block.tool_use_id) {
        answered.add(block.tool_use_id);
        continue;
      }
      if (block.type !== "tool_use" || block.name !== "AskUserQuestion" || !block.id) continue;
      const questions = normalizeQuestions(block.input);
      if (questions.length > 0) latest = { toolUseId: block.id, questions };
    }
  }
  // Ordering is safe either way: a result for the last question can only appear
  // after it, so checking membership once at the end is enough.
  if (!latest || answered.has(latest.toolUseId)) return null;
  return latest;
}

/** Drops anything not shaped like a question — `input` is raw model output. */
function normalizeQuestions(input: unknown): PendingQuestion[] {
  const raw = (input as { questions?: unknown } | undefined)?.questions;
  if (!Array.isArray(raw)) return [];
  const out: PendingQuestion[] = [];
  for (const q of raw) {
    const rec = q as { header?: unknown; question?: unknown; multiSelect?: unknown; options?: unknown };
    if (typeof rec?.question !== "string" || !rec.question.trim()) continue;
    const options: PendingQuestion["options"] = [];
    for (const o of Array.isArray(rec.options) ? rec.options : []) {
      const opt = o as { label?: unknown; description?: unknown };
      if (typeof opt?.label !== "string" || !opt.label.trim()) continue;
      options.push({
        label: opt.label.trim(),
        description: typeof opt.description === "string" && opt.description.trim() ? opt.description.trim() : undefined,
      });
    }
    if (options.length === 0) continue;
    out.push({
      header: typeof rec.header === "string" && rec.header.trim() ? rec.header.trim() : "質問",
      question: rec.question.trim(),
      multiSelect: rec.multiSelect === true,
      options,
    });
  }
  return out;
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
  uuid?: string;
  timestamp?: string;
  message?: { role?: string; content?: unknown };
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
