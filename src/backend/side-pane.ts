/**
 * Removes a side pane a Claude Code mod draws to the right of the TUI, so the
 * screen reads as if the mod were not installed.
 *
 * A mod pane (qa-guide is the one seen in use) shares every row with the TUI,
 * separated by a `│` drawn in one fixed column:
 *
 *     ❯ 1. 偽タイマーで単体テスト (Recommended)          │ 1 偽タイマーで単体テスト…
 *       4. Type something.                                │おすすめ
 *
 * Left in, the pane's text sits after every option and every rule, so no
 * line-anchored parser matches and a question that is plainly on screen is
 * reported as unreadable — or, on herdr, read as a y/n permission menu. Captured
 * from live panes (divider at display column 128 on Orca, 70 on herdr); the pane
 * opens and closes with the question, and Claude Code draws its composer and
 * footer full-width below it, so a read can hold rows with the pane, rows
 * without it, and scrollback from an earlier one.
 *
 * Each run of consecutive rows sharing a divider column is cut on its own. A
 * run counts only when some of its rows are blank left of the divider, which a
 * pane's divider always has (it is drawn down the whole pane) and a table's
 * column border never does — a transcript table also draws `│` in a fixed column
 * across many rows, and cutting it would lose content for nothing.
 */

const DIVIDER = "│";
const MIN_RUN_ROWS = 8;
const MIN_BLANK_LEFT_ROWS = 3;
// A box drawn from the left edge (omp's welcome panel, a table) has blank text
// left of its border by construction; a side pane always has the TUI to its left.
const MIN_DIVIDER_COLUMN = 40;

// The East Asian Wide code points scattered through the symbol blocks, which
// the transcript does use (✅ ❌ ⭐ ⚡); their neighbours there are narrow.
const WIDE_SYMBOLS = new Set([
  0x231a, 0x231b, 0x23e9, 0x23ea, 0x23eb, 0x23ec, 0x23f0, 0x23f3, 0x25fd, 0x25fe, 0x2614, 0x2615,
  ...Array.from({ length: 12 }, (_, i) => 0x2648 + i),
  0x267f, 0x2693, 0x26a1, 0x26aa, 0x26ab, 0x26bd, 0x26be, 0x26c4, 0x26c5, 0x26ce, 0x26d4, 0x26ea,
  0x26f2, 0x26f3, 0x26f5, 0x26fa, 0x26fd, 0x2705, 0x270a, 0x270b, 0x2728, 0x274c, 0x274e, 0x2753,
  0x2754, 0x2755, 0x2757, 0x2795, 0x2796, 0x2797, 0x27b0, 0x27bf, 0x2b1b, 0x2b1c, 0x2b50, 0x2b55,
]);

/** Terminal cells a code point takes: 2 for East Asian wide/full-width, 0 for combining marks. */
export function cellWidth(cp: number): number {
  if ((cp >= 0x0300 && cp <= 0x036f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if (
    WIDE_SYMBOLS.has(cp) ||
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

/** Display column → string index of every divider glyph in a row. */
function dividerColumns(row: string): Map<number, number> {
  const found = new Map<number, number>();
  let col = 0;
  let idx = 0;
  for (const ch of row) {
    if (ch === DIVIDER) found.set(col, idx);
    col += cellWidth(ch.codePointAt(0)!);
    idx += ch.length;
  }
  return found;
}

export function stripSidePane(text: string): string {
  const rows = text.split("\n");
  const columns = rows.map(dividerColumns);
  const cutAt: (number | undefined)[] = new Array(rows.length);

  for (let start = 0; start < rows.length; start++) {
    for (const col of columns[start].keys()) {
      if (col < MIN_DIVIDER_COLUMN) continue;
      if (start > 0 && columns[start - 1].has(col)) continue; // not the start of this column's run
      let end = start;
      while (end + 1 < rows.length && columns[end + 1].has(col)) end++;
      if (end - start + 1 < MIN_RUN_ROWS) continue;
      let blankLeft = 0;
      for (let i = start; i <= end; i++) {
        if (!rows[i].slice(0, columns[i].get(col)).trim()) blankLeft++;
      }
      if (blankLeft < MIN_BLANK_LEFT_ROWS) continue;
      for (let i = start; i <= end; i++) {
        const idx = columns[i].get(col)!;
        if (cutAt[i] === undefined || idx < cutAt[i]!) cutAt[i] = idx;
      }
    }
  }

  if (cutAt.every((idx) => idx === undefined)) return text;
  return rows.map((row, i) => (cutAt[i] === undefined ? row : row.slice(0, cutAt[i]).trimEnd())).join("\n");
}
