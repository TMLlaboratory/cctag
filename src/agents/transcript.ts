import { createReadStream, statSync } from "node:fs";
import { open } from "node:fs/promises";
const RECENT_RECORD_LIMIT = 256;
const RECENT_BYTE_LIMIT = 256 * 1024;
const BACKWARD_SCAN_CHUNK_SIZE = 64 * 1024;

export function transcriptSizeIfAvailable(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

export function transcriptSizeSafe(path: string): number {
  return transcriptSizeIfAvailable(path) ?? 0;
}

/**
 * Whether this transcript came into existence after `sinceMs`.
 *
 * Distinguishes a file that genuinely did not exist yet from one that was merely
 * unresolvable for a moment — the locators fold a failed readdir, stat or
 * first-line read into the same `null`, so "no path, then a path" alone cannot
 * tell those apart, and treating the second as new would replay a whole existing
 * session into the thread.
 *
 * Conservative when the answer isn't knowable: a filesystem that reports no
 * birth time (birthtimeMs of 0) counts as not-new, so the caller baselines at the
 * end and drops output rather than risking a replay.
 */
export function transcriptCreatedAfter(path: string, sinceMs: number): boolean {
  try {
    const { birthtimeMs } = statSync(path);
    // NaN as well as 0: an unusable value must take the conservative branch, and
    // `NaN >= x` being false would only reach it by accident.
    if (!Number.isFinite(birthtimeMs) || birthtimeMs <= 0) return false;
    // No tolerance on the comparison, deliberately. A tolerance was tried, to
    // cover filesystems reporting creation to the second — the concern being that
    // a file created just after watching began could carry a birth time from just
    // before it, and lose its first turn. But it also admits a transcript created
    // shortly *before* watching, which is precisely the transient-resolution case
    // this guard exists for, and a test caught the regression. Measured on this
    // platform, birth times resolve to well under a millisecond (0.05s apart on
    // consecutively created files), so the precision the tolerance protected
    // against is not the precision on offer; and of the two failures, dropping
    // one turn beats replaying a whole session into the thread.
    return birthtimeMs >= sinceMs;
  } catch {
    return false;
  }
}

/**
 * Reads all complete JSONL lines after `offset` bytes. Returns the parsed
 * records (as loosely-typed objects — each driver casts to its own record
 * shape) and the new offset (which stops at the last full line — a
 * partially-written trailing line is left unconsumed for the next read).
 *
 * Agent-agnostic: every driver's transcript is JSONL, so only the per-line
 * schema differs, not the tailing mechanics.
 */
export async function readNewRecords(
  path: string,
  offset: number,
): Promise<{ records: Record<string, unknown>[]; newOffset: number }> {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return { records: [], newOffset: offset };
  }
  if (size <= offset) return { records: [], newOffset: offset };

  const chunk = await new Promise<Buffer>((resolve, reject) => {
    const parts: Buffer[] = [];
    const stream = createReadStream(path, { start: offset });
    stream.on("data", (d) => parts.push(d as Buffer));
    stream.on("end", () => resolve(Buffer.concat(parts)));
    stream.on("error", reject);
  });

  const text = chunk.toString("utf8");
  const lastNewline = text.lastIndexOf("\n");
  if (lastNewline === -1) {
    // no complete line yet
    return { records: [], newOffset: offset };
  }
  const complete = text.slice(0, lastNewline);
  const newOffset = offset + Buffer.byteLength(complete, "utf8") + 1; // +1 for the newline

  const records: Record<string, unknown>[] = [];
  for (const line of complete.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // skip malformed line defensively
    }
  }
  return { records, newOffset };
}

/**
 * Reads a bounded transcript suffix independently of any consumer's output
 * offset. Returned records stay chronological; lifecycle callers scan their
 * boundaries backwards to find the most recent start and end.
 */
export async function readRecentRecords(path: string): Promise<Record<string, unknown>[]> {
  const file = await open(path, "r").catch(() => null);
  if (!file) return [];

  try {
    const { size } = await file.stat();
    if (size <= 0) return [];

    const length = Math.min(size, RECENT_BYTE_LIMIT);
    const start = size - length;
    let startsAtRecordBoundary = start === 0;
    if (start > 0) {
      const precedingByte = Buffer.allocUnsafe(1);
      const result = await file.read(precedingByte, 0, 1, start - 1);
      startsAtRecordBoundary = result.bytesRead === 1 && precedingByte[0] === 0x0a;
    }
    const bytes = Buffer.allocUnsafe(length);
    let used = 0;
    while (used < length) {
      const result = await file.read(bytes, used, length - used, start + used);
      if (result.bytesRead === 0) break;
      used += result.bytesRead;
    }
    if (used === 0) return [];

    const text = bytes.subarray(0, used).toString("utf8");
    const firstNewline = startsAtRecordBoundary ? -1 : text.indexOf("\n");
    if (!startsAtRecordBoundary && firstNewline === -1) return [];
    const suffix = startsAtRecordBoundary ? text : text.slice(firstNewline + 1);
    const lastNewline = suffix.lastIndexOf("\n");
    if (lastNewline === -1) return [];

    const lines = suffix.slice(0, lastNewline).split("\n").slice(-RECENT_RECORD_LIMIT);
    const records: Record<string, unknown>[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as unknown;
        if (typeof record === "object" && record !== null && !Array.isArray(record)) {
          records.push(record as Record<string, unknown>);
        }
      } catch {
        // Skip malformed transcript lines defensively.
      }
    }
    return records;
  } catch {
    return [];
  } finally {
    await file.close().catch(() => {});
  }
}
/**
 * Reads complete JSONL records backwards from a fixed byte offset. Bytes
 * appended after `endOffset` are never part of this snapshot; the returned
 * offset is after its last complete newline-terminated record.
 */
// Same-size replacement/rotation is out of scope: Claude/OMP transcripts append in place and new sessions use a new path.
// OMP's open-file identity is verified separately by device and inode.
export async function readLastMatchingRecordBefore(
  path: string,
  endOffset: number,
  matches: (record: Record<string, unknown>) => boolean,
): Promise<{ record: Record<string, unknown> | null; completeOffset: number } | null> {
  const file = await open(path, "r").catch(() => null);
  if (!file) return null;

  try {
    const { size } = await file.stat();
    if (size < endOffset || statSync(path).size < endOffset) return null;

    let position = endOffset;
    let completeOffset = 0;
    let foundCompleteBoundary = false;
    let record: Record<string, unknown> | null = null;
    let fragments: Buffer[] = [];
    let fragmentBytes = 0;
    const lineParts: Buffer[] = [];
    while (position > 0 && record === null) {
      const start = Math.max(0, position - BACKWARD_SCAN_CHUNK_SIZE);
      const bytes = Buffer.allocUnsafe(position - start);
      let used = 0;
      while (used < bytes.length) {
        const result = await file.read(bytes, used, bytes.length - used, start + used);
        if (result.bytesRead === 0) return null;
        used += result.bytesRead;
      }

      let right = bytes.length;
      if (!foundCompleteBoundary) {
        const lastNewline = bytes.lastIndexOf(0x0a);
        if (bytes[bytes.length - 1] === 0x0a) {
          completeOffset = start + bytes.length;
          right -= 1;
          foundCompleteBoundary = true;
        } else if (lastNewline !== -1) {
          completeOffset = start + lastNewline + 1;
          right = lastNewline;
          foundCompleteBoundary = true;
        } else {
          // No complete record yet; the trailing partial may span more chunks.
          position = start;
          continue;
        }
      }

      while (right > 0) {
        const previousNewline = bytes.lastIndexOf(0x0a, right - 1);
        const lineStart = previousNewline + 1;
        const fragment = bytes.subarray(lineStart, right);
        if (previousNewline === -1 && start > 0) {
          if (fragment.length > 0) {
            fragments.push(fragment);
            fragmentBytes += fragment.length;
          }
          break;
        }

        if (fragment.length > 0 || fragments.length > 0) {
          let line = fragment;
          if (fragments.length > 0) {
            lineParts.length = 0;
            lineParts.push(fragment);
            while (fragments.length > 0) lineParts.push(fragments.pop()!);
            line = Buffer.concat(lineParts, fragment.length + fragmentBytes);
            lineParts.length = 0;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(line.toString("utf8")) as unknown;
          } catch {
            parsed = null;
          }
          if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
            const candidate = parsed as Record<string, unknown>;
            if (matches(candidate)) {
              record = candidate;
              break;
            }
          }
        }

        fragments.length = 0;
        fragmentBytes = 0;
        if (previousNewline === -1) {
          right = 0;
          break;
        }
        right = previousNewline;
      }

      position = start;
    }

    if ((await file.stat()).size < endOffset || statSync(path).size < endOffset) return null;
    return { record, completeOffset: foundCompleteBoundary ? completeOffset : 0 };
  } catch {
    return null;
  } finally {
    await file.close().catch(() => {});
  }
}
