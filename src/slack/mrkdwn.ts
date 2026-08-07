/** Converts common Markdown constructs (as Claude Code emits them) into Slack mrkdwn. */
export function markdownToMrkdwn(input: string): string {
  const fenceSplit = input.split(/(```[\s\S]*?```)/g);
  return fenceSplit
    .map((part, i) => {
      if (i % 2 === 1) return part; // inside a fenced code block — leave verbatim
      let s = part;
      s = s.replace(/\*\*(.+?)\*\*/g, "*$1*"); // bold
      s = s.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "_$1_"); // italic *x* -> _x_
      s = s.replace(/^(#{1,6})\s+(.+)$/gm, "*$2*"); // headings -> bold line
      s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "<$2|$1>"); // links
      s = s.replace(/^(\s*)[-*]\s+/gm, "$1• "); // bullet lists
      return s;
    })
    .join("");
}

const CHUNK_LIMIT = 3900;

/**
 * Splits text into chunks under CHUNK_LIMIT, preferring paragraph boundaries
 * and never splitting inside a fenced code block (re-opens the fence if a
 * block has to be split across chunks).
 */
export function chunkForSlack(text: string, limit = CHUNK_LIMIT): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;
  let openFence = false;

  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf("\n\n", limit);
    if (cut <= 0) cut = remaining.lastIndexOf("\n", limit);
    if (cut <= 0) cut = limit;

    let piece = remaining.slice(0, cut);
    const fenceCount = (piece.match(/```/g) ?? []).length;
    const pieceOpensFence: boolean = openFence ? fenceCount % 2 === 0 : fenceCount % 2 === 1;

    if (openFence) piece = "```\n" + piece; // continuation marker for readability
    if (pieceOpensFence) piece += "\n```"; // close the fence for this chunk

    chunks.push(piece);
    openFence = pieceOpensFence;
    remaining = remaining.slice(cut).replace(/^\n+/, "");
  }
  if (remaining.length > 0) {
    chunks.push(openFence ? "```\n" + remaining : remaining);
  }
  return chunks;
}

/** A Markdown pipe table, cells still holding their inline Markdown. */
export interface MarkdownTable {
  header: string[];
  rows: string[][];
}

/**
 * One piece of a turn's output, in the order it appeared.
 *
 * Text pieces are already mrkdwn-converted and chunked; table pieces are still
 * raw so the caller can decide between a Block Kit table and a fallback.
 */
export type SlackSegment = { kind: "text"; text: string } | { kind: "table"; table: MarkdownTable };

/** `| a | b |` — a row candidate. Leading/trailing pipes are optional in the
 *  wild, but requiring at least one interior pipe keeps prose out. */
const TABLE_ROW = /^\s*\|?.*\|.*\|?\s*$/;
/** `|---|:--:|` — the separator that makes the line above it a header. */
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/;

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

/**
 * Splits a turn's Markdown into text and table segments, preserving their
 * original order.
 *
 * Order is the point: `reportTurnResult` joins every collected text and posts
 * the result, so a table that appeared between two paragraphs has to stay
 * between them. Emitting all the tables at the end would be the easy bug here.
 *
 * Fenced code is split off first and never inspected, so a pipe table shown as
 * an example inside ``` stays literal text — the same reason
 * `markdownToMrkdwn` splits on fences before substituting anything.
 */
export function segmentForSlack(markdown: string): SlackSegment[] {
  const segments: SlackSegment[] = [];
  const pushText = (raw: string): void => {
    const trimmed = raw.replace(/^\n+|\n+$/g, "");
    if (!trimmed) return;
    for (const chunk of chunkForSlack(markdownToMrkdwn(trimmed))) segments.push({ kind: "text", text: chunk });
  };

  for (const [i, part] of markdown.split(/(```[\s\S]*?```)/g).entries()) {
    if (i % 2 === 1) {
      // A fenced block is opaque: never a table, and its own text segment so
      // chunkForSlack's fence handling still sees a balanced fence.
      pushText(part);
      continue;
    }
    const lines = part.split("\n");
    let buffer: string[] = [];
    let cursor = 0;
    while (cursor < lines.length) {
      const isTableStart =
        cursor + 1 < lines.length && TABLE_ROW.test(lines[cursor]) && TABLE_SEPARATOR.test(lines[cursor + 1]);
      if (!isTableStart) {
        buffer.push(lines[cursor]);
        cursor += 1;
        continue;
      }
      pushText(buffer.join("\n"));
      buffer = [];
      const header = splitRow(lines[cursor]);
      cursor += 2; // header + separator
      const rows: string[][] = [];
      while (cursor < lines.length && lines[cursor].includes("|") && TABLE_ROW.test(lines[cursor])) {
        const cells = splitRow(lines[cursor]);
        // Pad or trim to the header's width so every row is rectangular —
        // Block Kit rejects ragged rows outright.
        while (cells.length < header.length) cells.push("");
        rows.push(cells.slice(0, header.length));
        cursor += 1;
      }
      segments.push({ kind: "table", table: { header, rows } });
    }
    pushText(buffer.join("\n"));
  }
  return segments;
}
