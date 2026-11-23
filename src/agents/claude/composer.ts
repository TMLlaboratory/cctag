import { stripVTControlCharacters } from "node:util";
import { cellWidth } from "../../backend/side-pane.js";

export interface ClaudeComposer {
  draft: string;
  caret: number;
  stashed: boolean;
  idle: boolean;
  frame: string;
  rawRow: string;
  nativeCaret?: true;
  nativeProbeFits?: boolean;
}

export const COMPOSER_BOTTOM_RULE_RE = /^[─━]+$/u;
// /rename draws the session name into the upper rule only (Claude Code 2.1.291, #28).
export const NAMED_COMPOSER_TOP_RULE_RE = /^[─━]+ .+ [─━]+$/u;
const RESET = "\x1b[0m";
const REVERSE = "\x1b[7m";
const SGR = /\x1b\[[0-9;]*m/g;
const ALTERNATE_SCREEN = /\x1b\[\?(?:47|1047|1049)h/u;
const ALTERNATE_PAINT = /^\x1b\[\?1049h\x1b\[!p(\x1b\[\?25l)?(?:\x1b\[\?(?:1000|1002|1003|1004|1006|2004|2031)h)*\x1b\[3g(?:\x1b\[\d+G\x1bH)*\x1b\[H/u;
const ALTERNATE_TRAILER = /^\x1b\[>4;2m\x1b\[\d+;\d+H\x1b\[0m(?:\x1b\[=\d+;\d+u)?(?:\x1b\(B)?(?:\x1b\]2;[^\p{Cc}]*\x1b\\)?(?:\x1b\[\?9001l)?\x1b\]7501;[^\p{Cc}]*\x1b\\$/u;
const NATIVE_INPUT_STYLE = /\x1b\[(?:0|2|38;2;\d+;\d+;\d+)m/g;
const NATIVE_INPUT_TEXT = /^[\x20-\x7e\u3000-\u303e\u3041-\u3096\u30a0-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff01-\uff9d\uffe0-\uffe6]*$/u;

export function parseClaudeHcComposer(ansi: string, cols: number, rows?: number): ClaudeComposer | null {
  if (!ansi.startsWith("\x18\x1b[!p") || !ansi.includes("\x1b[H\x1b[2J")) return null;
  // Accepting a caret without the final status report could accept a truncated paint.
  const position = /\x1b\[>4;2m\x1b\[(\d+);(\d+)H\x1b\[0m[^\r\n]*\x1b\]7501;[^\r\n]*:app=claude-code(?::[^\x1b\r\n]*)?\x1b\\$/u.exec(ansi);
  if (!position) return null;
  const paint = ansi.slice(0, position.index);
  const index = Number(position[1]) - 1;
  const column = Number(position[2]);
  const alternate = ALTERNATE_SCREEN.exec(paint);
  if (!alternate) return parseFrame(paint.split("\r\n"), index, cols, column);
  // The observer serializes the inactive main screen first. Cursor coordinates belong to the alternate paint.
  const prefix = ALTERNATE_PAINT.exec(paint.slice(alternate.index));
  if (!prefix || !ALTERNATE_TRAILER.test(position[0])) return null;
  const active = paint.slice(alternate.index + prefix[0].length);
  const lines = active.split("\r\n");
  if (lines.length !== rows || /[\p{Cc}]/u.test(active.replace(SGR, "").replaceAll("\r\n", ""))) return null;
  return parseFrame(lines, index, cols, column, !prefix[1]);
}

export function parseClaudeHerdrComposer(ansi: string, cols: number): ClaudeComposer | null {
  const lines = ansi.split(/\r?\n/);
  let index = lines.length - 1;
  while (index >= 0 && !lines[index]?.startsWith("❯\u00a0")) index--;
  return parseFrame(lines, index, cols);
}

function parseFrame(lines: string[], index: number, cols: number, column?: number, visibleNativeCaret = false): ClaudeComposer | null {
  const row = lines[index];
  const upper = stripVTControlCharacters(lines[index - 1] ?? "");
  const lower = stripVTControlCharacters(lines[index + 1] ?? "");
  if (!row || !COMPOSER_BOTTOM_RULE_RE.test(lower) || lower.length !== cols) return null;
  if (upper !== lower && (!NAMED_COMPOSER_TOP_RULE_RE.test(upper) ||
    [...upper].reduce((width, char) => width + cellWidth(char.codePointAt(0)!), 0) !== cols)) return null;
  const footer = lines.slice(index + 2).map(stripVTControlCharacters).join("\n").trimEnd();
  if (footer.split("\n").some((line) => !/^ {2,}\S/u.test(line)) ||
    /(?:^|\s)❯|esc to (?:close|exit)/iu.test(footer)) return null;
  if (!row.startsWith("❯\u00a0")) return null;
  const parts = row.slice(2).split(REVERSE);
  const native = visibleNativeCaret && parts.length === 1 && column !== undefined;
  let draft: string;
  let caret: number;
  if (native) {
    draft = parts[0]!.replace(NATIVE_INPUT_STYLE, "");
    // shortcut: exclude emoji and combining sequences (including halfwidth voicing marks) until grapheme carets are verified.
    if (!NATIVE_INPUT_TEXT.test(draft)) return null;
    caret = 0;
    let cell = 3;
    while (cell < column && caret < draft.length) cell += cellWidth(draft.charCodeAt(caret++));
    if (cell !== column) return null;
  } else {
    if (parts.length !== 2) return null;
    const cursor = parts[1]!.indexOf(RESET);
    if (cursor < 0) return null;
    const before = parts[0]!.replace(SGR, "");
    const cell = parts[1]!.slice(0, cursor);
    const after = parts[1]!.slice(cursor + RESET.length).replace(SGR, "");
    const caretColumn = 3 + [...before].reduce((width, char) => width + cellWidth(char.codePointAt(0)!), 0);
    if ((column !== undefined && column !== caretColumn) || [...cell].length !== 1) return null;
    // The paint omits a trailing space under the caret. The visible text alone cannot prove emptiness or exact restoration.
    draft = before + (cell === " " && after === "" ? "" : cell + after);
    caret = before.length;
  }
  if (/[\p{C}\u00a0]/u.test(draft) || (draft && !draft.trim()) || /\[(?:Pasted|Image)\b/i.test(draft)) return null;
  const draftEnd = 3 + [...draft].reduce((width, char) => width + cellWidth(char.codePointAt(0)!), 0);
  if (draftEnd >= cols) return null;
  const preceding = stripVTControlCharacters(lines.slice(1, index - 1).join("\n")).trimEnd().split("\n").at(-1) ?? "";
  const idle = !/^[✳✽✻]\s.*…/u.test(preceding.trimStart()) && !/esc to (?:interrupt|cancel)/i.test(footer);
  const banner = lines[index - 2] ?? "";
  // The fullscreen renderer right-aligns the stash banner above the rules instead of in the footer.
  const fullscreenStash = native && /^ +\x1b\[0m\x1b\[38;2;153;153;153m draft stashed\x1b\[0m$/u.test(banner) &&
    stripVTControlCharacters(banner).length === cols - 2;
  if (native && !fullscreenStash && /\bdraft stashed\s*$/u.test(stripVTControlCharacters(banner))) return null;
  const stashed = fullscreenStash || /\bdraft stashed\s*$/m.test(footer);
  // The native probe can expose an unpainted space before its sentinel.
  return {
    draft, caret, stashed, idle, frame: upper + "\n" + footer, rawRow: row,
    ...(native ? { nativeCaret: true, nativeProbeFits: draftEnd + 2 < cols } : {}),
  };
}
