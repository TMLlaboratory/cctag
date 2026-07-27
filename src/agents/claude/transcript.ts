import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
 * Absolute paths the turn wrote via the Write tool.
 *
 * Only Write is inspected: it's the one tool whose input names its output file
 * outright. Files produced by Bash (a matplotlib script, an ImageMagick call)
 * aren't recoverable from the transcript at all, which is exactly the gap the
 * `.cctag/outbox` convention covers.
 */
export function extractWrittenPaths(records: TranscriptRecord[]): string[] {
  const paths: string[] = [];
  for (const r of records) {
    if (r.type !== "assistant") continue;
    for (const block of contentBlocks(r)) {
      if (block.type !== "tool_use" || block.name !== "Write") continue;
      const filePath = (block.input as { file_path?: unknown } | undefined)?.file_path;
      if (typeof filePath === "string" && filePath) paths.push(filePath);
    }
  }
  return paths;
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
