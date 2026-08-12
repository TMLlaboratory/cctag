import { createReadStream, statSync } from "node:fs";

export function transcriptSizeSafe(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
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
    return birthtimeMs > 0 && birthtimeMs >= sinceMs;
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
