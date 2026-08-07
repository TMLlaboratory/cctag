import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, resolve } from "node:path";

/**
 * Slack ⇄ agent file attachment plumbing, kept free of Slack SDK types so
 * standalone and Hub–Spoke modes share one implementation (same reasoning as
 * notifier.ts).
 *
 * The inbound direction hinges on a verified Claude Code behavior: an image
 * file *path* appearing in a submitted prompt is turned by the TUI into a real
 * image attachment — the path text is removed, an `[Image #N]` placeholder
 * takes its place, and the bytes land in the transcript as a base64 `image`
 * content block. So cctag downloads the file, writes it to disk, and puts the
 * path in the prompt. It deliberately never inlines base64 into the prompt
 * text: measured on a 2.8MB PNG, the attachment path costs ~3.6k tokens (Claude
 * Code re-encodes and downscales it first) while the same bytes pasted as text
 * would be ~170k tokens — and wouldn't be visible to the model as an image at
 * all.
 */

/** Extensions Claude Code auto-attaches as an image when their path appears in
 *  a prompt (verified for .png/.jpg; the rest are the formats the API's image
 *  blocks accept, so they take the same path). */
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

/** Outbound: what's worth pushing into the thread on its own, because a Slack
 *  reader can't get it from the turn's text output. Deliberately excludes
 *  source files and .md — the agent writes those constantly, and uploading
 *  every one would bury the thread (plan .md files have their own path, see
 *  TurnEngine.attachPlanFile). */
const OUTBOUND_EXTS = new Set([...IMAGE_EXTS, ".svg", ".pdf"]);

/** Downloaded inbound files older than this are pruned on the next save.
 *  They're only needed until the agent has read them, but keeping a few days
 *  means a thread can still refer back to "the screenshot I sent earlier". */
const INBOX_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface AttachmentLimits {
  maxFileBytes: number;
  maxFileCount: number;
}

/** A Slack file as reported on a message event — metadata only. The bytes are
 *  fetched separately (by the side that holds the bot token). */
export interface IncomingFile {
  id: string;
  name: string;
  mimetype?: string;
  size?: number;
  /** Direct download URL, when the triggering event carried one. Optional
   *  because it does NOT cross the Hub–Spoke boundary: the Spoke sends only the
   *  id and the Hub re-resolves the URL itself, so a download URL never has to
   *  be paired with the bot token needed to use it. */
  downloadUrl?: string;
}

/** Fetches an inbound file's bytes as base64, or null if unavailable.
 *  Standalone downloads with the bot token directly; the Spoke asks the Hub
 *  over the WebSocket RPC. */
export type FileFetcher = (file: IncomingFile) => Promise<string | null>;

export interface SavedAttachment {
  /** Absolute path on the machine running the agent. */
  path: string;
  /** Original (sanitized) Slack filename, for user-facing messages. */
  name: string;
  isImage: boolean;
}

export interface SaveResult {
  saved: SavedAttachment[];
  /** Human-readable reasons, one per rejected file, for posting back to the thread. */
  skipped: string[];
}

export interface OutboundAttachment {
  path: string;
  name: string;
  contentB64: string;
  /** Carried through from SendUserFile's `caption`; absent for the write and
   *  outbox routes, which have no caption to carry. */
  caption?: string;
}

/** name -> "mtimeMs:size", so a file that was rewritten in place still counts as new. */
export type DirSnapshot = Record<string, string>;

/**
 * Where an outbound candidate came from, which is what decides whether the
 * extension allowlist applies to it.
 *
 * `write` is inferred intent — the agent changed a file, which is not the same
 * as asking for it to be sent — so it stays bounded by OUTBOUND_EXTS. `send`
 * (SendUserFile) and `outbox` are both explicit "deliver this", so they take
 * any file type.
 */
export type OutboundOrigin = "write" | "send" | "outbox";

/** One file to consider uploading. Deliberately flat — one entry per file, never
 *  grouped by caption or tool use: the size/count caps and the dedup downstream
 *  both count entries, and nesting would make them silently miscount. */
export interface OutboundCandidate {
  path: string;
  origin: OutboundOrigin;
  /** SendUserFile's own caption, used as the upload comment when present. */
  caption?: string;
}

/**
 * Pairs the agent's outbound file requests with their outcomes, so only requests
 * that actually succeeded become upload candidates.
 *
 * This has to be stateful rather than a per-batch filter: a `tool_use` and its
 * `tool_result` land in separate transcript records and routinely arrive in
 * different poll batches, so a batch-local check would miss the outcome and
 * either drop every request or trust every one. Trusting every one is the
 * dangerous direction — a denied Write leaves the *existing* file untouched, and
 * uploading on the request alone would send a file the human just refused to
 * overwrite (verified against a real denial: `is_error: true`, file unchanged).
 * The same reasoning covers a denied `SendUserFile`.
 *
 * Both routes are tracked here at once, on purpose: `SendUserFile` is the
 * intended long-term route but its availability outside an app-paired session
 * rests on a single probe, so Write detection stays as the fallback until
 * production confirms the tool actually fires (see issue #2).
 *
 * Ownership moves between the BackgroundWatcher and TurnEngine when a blocked
 * terminal is adopted, so the instance is handed over rather than rebuilt.
 */
export class WrittenFileTracker {
  /** tool_use_id -> the files that use would confirm, with their origin. */
  private pending = new Map<string, OutboundCandidate[]>();
  /** Keyed by path so the same file reached twice collapses to one upload. */
  private confirmed = new Map<string, OutboundCandidate>();

  ingest(output: {
    writeRequests?: Array<{ toolUseId: string; path: string }>;
    sendFileRequests?: Array<{ toolUseId: string; paths: string[]; caption?: string }>;
    toolOutcomes?: Array<{ toolUseId: string; ok: boolean }>;
  }): void {
    for (const w of output.writeRequests ?? []) {
      this.pending.set(w.toolUseId, [{ path: w.path, origin: "write" }]);
    }
    for (const s of output.sendFileRequests ?? []) {
      this.pending.set(
        s.toolUseId,
        s.paths.map((p) => ({ path: p, origin: "send" as const, caption: s.caption })),
      );
    }
    for (const o of output.toolOutcomes ?? []) {
      const entries = this.pending.get(o.toolUseId);
      if (entries === undefined) continue; // an outcome for some other tool
      this.pending.delete(o.toolUseId);
      if (!o.ok) continue;
      for (const e of entries) this.remember(e);
    }
  }

  /**
   * A `send` supersedes a `write` for the same path, regardless of arrival
   * order: the common sequence is the agent writing a chart and *then* sending
   * it, and the send is the one carrying the caption and the explicit intent.
   * Between two sends the first wins, which is arbitrary but stable.
   */
  private remember(entry: OutboundCandidate): void {
    const existing = this.confirmed.get(entry.path);
    if (existing && !(existing.origin === "write" && entry.origin === "send")) return;
    this.confirmed.set(entry.path, entry);
  }

  /** Confirmed requests only, one entry per file. A request whose outcome never
   *  arrived stays out — the turn ending before the result is written means it
   *  didn't complete. */
  paths(): OutboundCandidate[] {
    return [...this.confirmed.values()];
  }
}

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

export function isImagePath(p: string): boolean {
  return IMAGE_EXTS.has(extname(p).toLowerCase());
}

export function isOutboundAttachable(p: string): boolean {
  return OUTBOUND_EXTS.has(extname(p).toLowerCase());
}

export function inboxDir(): string {
  return join(homedir(), ".cctag", "inbox");
}

/** `<cwd>/.cctag/outbox` — per-pane, NOT a single shared directory: several
 *  threads can be paired to different panes at once, and a global outbox would
 *  post one pane's file into another pane's thread. */
export function outboxDir(cwd: string): string {
  return join(cwd, ".cctag", "outbox");
}

/**
 * Strips what would break the one-path-per-line prompt convention or the
 * filesystem, and keeps everything else. Spaces and non-ASCII are kept on
 * purpose: Slack's own screenshot filenames contain both ("スクリーンショット
 * 2026-07-27 14.02.33.png"), and Claude Code's path→attachment detection was
 * verified to handle such a path unquoted.
 */
export function sanitizeAttachmentName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  // Control characters only. A newline in particular would split one filename
  // across two lines of the prompt block and be read as two bogus paths.
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return cleaned || "file";
}

/** Best-effort removal of stale downloads. Never throws — a full or
 *  permission-denied inbox must not fail the turn that triggered the prune. */
function pruneInbox(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - INBOX_MAX_AGE_MS;
  for (const name of names) {
    const p = join(dir, name);
    try {
      if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
    } catch {
      // raced with another prune, or not ours to delete — skip
    }
  }
}

/**
 * Downloads the inbound files cctag is willing to accept and writes them under
 * `dir`. Rejections are returned rather than thrown, so a message mixing one
 * huge file with one usable image still gets the usable one through.
 */
export async function saveIncomingFiles(
  files: IncomingFile[],
  fetch: FileFetcher,
  limits: AttachmentLimits,
  dir: string = inboxDir(),
): Promise<SaveResult> {
  const saved: SavedAttachment[] = [];
  const skipped: string[] = [];
  if (files.length === 0) return { saved, skipped };

  pruneInbox(dir);

  for (const f of files) {
    if (saved.length >= limits.maxFileCount) {
      skipped.push(`${f.name}（1メッセージあたり${limits.maxFileCount}件までです）`);
      continue;
    }
    // Slack reports the size up front, so an oversized file can be rejected
    // without transferring it at all.
    if (f.size !== undefined && f.size > limits.maxFileBytes) {
      skipped.push(`${f.name}（${mb(f.size)}MB — 上限は${mb(limits.maxFileBytes)}MB）`);
      continue;
    }

    let b64: string | null;
    try {
      b64 = await fetch(f);
    } catch (err) {
      console.error(`[attachments] download failed for ${f.name}:`, err instanceof Error ? err.message : err);
      b64 = null;
    }
    if (!b64) {
      skipped.push(`${f.name}（ダウンロードできませんでした）`);
      continue;
    }

    const bytes = Buffer.from(b64, "base64");
    // Re-check against the real byte count: `size` is advisory (absent on some
    // events), and this is the last point before it hits the disk.
    if (bytes.byteLength > limits.maxFileBytes) {
      skipped.push(`${f.name}（${mb(bytes.byteLength)}MB — 上限は${mb(limits.maxFileBytes)}MB）`);
      continue;
    }

    const name = sanitizeAttachmentName(f.name);
    // Slack file ids are unique per upload, so this can't collide even when
    // two messages attach identically-named screenshots.
    const path = join(dir, `${f.id}-${name}`);
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, bytes);
    } catch (err) {
      console.error(`[attachments] write failed for ${path}:`, err instanceof Error ? err.message : err);
      skipped.push(`${f.name}（保存できませんでした）`);
      continue;
    }
    saved.push({ path, name, isImage: isImagePath(name) });
  }

  return { saved, skipped };
}

/**
 * Appends the saved files' paths to the prompt, one per line and last.
 *
 * Position doesn't survive for images anyway (Claude Code lifts each one out
 * and prepends an `[Image #N]` placeholder), and one-path-per-line is the exact
 * shape the path→attachment detection was verified against. Agents without that
 * detection just see a labeled list of paths they can open with their own
 * file-reading tool, which is also what happens here for non-image files.
 */
export function buildPromptWithAttachments(text: string, saved: SavedAttachment[]): string {
  if (saved.length === 0) return text;
  const block = ["[Slackで添付されたファイル]", ...saved.map((s) => s.path)].join("\n");
  const body = text.trim();
  return body ? `${body}\n\n${block}` : block;
}

export function countImages(saved: SavedAttachment[]): number {
  return saved.filter((s) => s.isImage).length;
}

/** Snapshots the outbox so the turn's own additions can be told apart from
 *  files that were already sitting there. Missing directory = empty snapshot. */
export function snapshotOutbox(cwd: string): DirSnapshot {
  const dir = outboxDir(cwd);
  const snapshot: DirSnapshot = {};
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return snapshot;
  }
  for (const name of names) {
    try {
      const st = statSync(join(dir, name));
      if (st.isFile()) snapshot[name] = `${st.mtimeMs}:${st.size}`;
    } catch {
      // vanished mid-scan — treat as absent
    }
  }
  return snapshot;
}

/**
 * Absolute paths of outbox files that are new or changed since `baseline`.
 *
 * Uploaded files are deliberately left in place rather than deleted: consuming
 * a directory the user can also write to is the kind of surprise that's hard to
 * undo, and the mtime/size comparison already makes re-posting the same
 * untouched file impossible.
 */
export function outboxAdditions(cwd: string, baseline: DirSnapshot): string[] {
  const dir = outboxDir(cwd);
  const current = snapshotOutbox(cwd);
  return Object.keys(current)
    .filter((name) => current[name] !== baseline[name])
    .sort()
    .map((name) => join(dir, name));
}

/**
 * Reads the files to upload, dropping duplicates (the same path can arrive from
 * both the outbox scan and transcript detection) and anything over the size
 * cap. Callers filter by extension *before* this: explicit routes (outbox,
 * SendUserFile) take any type, while transcript-detected writes are narrowed to
 * OUTBOUND_EXTS.
 *
 * Dedup is by resolved absolute path and keeps the *first* entry, so a caller
 * that wants a captioned duplicate to win has to order it first — which is what
 * WrittenFileTracker already does by letting `send` supersede `write`.
 */
export function readOutboundAttachments(
  candidates: OutboundCandidate[],
  limits: AttachmentLimits,
  /** Base for any relative path. Must be the agent's cwd, not cctag's — the
   *  paths come from the agent's own transcript, so cctag's process cwd would
   *  resolve them somewhere unrelated. */
  baseDir: string,
): {
  files: OutboundAttachment[];
  skipped: string[];
} {
  const files: OutboundAttachment[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();

  for (const c of candidates) {
    const abs = resolve(baseDir, c.path);
    if (seen.has(abs)) continue;
    seen.add(abs);

    let size: number;
    try {
      const st = statSync(abs);
      if (!st.isFile()) continue;
      size = st.size;
    } catch {
      continue; // written then removed during the turn — nothing to send
    }
    if (size === 0) continue; // still being written, or a placeholder
    if (files.length >= limits.maxFileCount) {
      skipped.push(`${sanitizeAttachmentName(abs)}（1ターンあたり${limits.maxFileCount}件までです）`);
      continue;
    }
    if (size > limits.maxFileBytes) {
      skipped.push(`${sanitizeAttachmentName(abs)}（${mb(size)}MB — 上限は${mb(limits.maxFileBytes)}MB）`);
      continue;
    }

    try {
      files.push({
        path: abs,
        name: sanitizeAttachmentName(abs),
        contentB64: readFileSync(abs).toString("base64"),
        caption: c.caption,
      });
    } catch (err) {
      console.error(`[attachments] read failed for ${abs}:`, err instanceof Error ? err.message : err);
    }
  }

  return { files, skipped };
}
