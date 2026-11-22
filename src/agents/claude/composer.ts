import { stripVTControlCharacters } from "node:util";
import { cellWidth } from "../../backend/side-pane.js";

export interface ClaudeComposer {
  draft: string;
  caret: number;
  stashed: boolean;
  idle: boolean;
  frame: string;
  rawRow: string;
}

const RULE = /^[─━]+$/u;
const RESET = "\x1b[0m";
const REVERSE = "\x1b[7m";
const SGR = /\x1b\[[0-9;]*m/g;

/** The full core observer paint contains Claude's inverse-video caret and its absolute position. */
export function parseClaudeHcComposer(ansi: string, cols: number): ClaudeComposer | null {
  if (!ansi.startsWith("\x18\x1b[!p") || !ansi.includes("\x1b[H\x1b[2J")) return null;
  // Finish at the observed status report so a truncated paint cannot qualify.
  const position = /\x1b\[>4;2m\x1b\[(\d+);(\d+)H\x1b\[0m[^\r\n]*\x1b\]7501;[^\r\n]*:app=claude-code(?::[^\x1b\r\n]*)?\x1b\\$/u.exec(ansi);
  if (!position) return null;
  const lines = ansi.slice(0, position.index).split("\r\n");
  return parseFrame(lines, Number(position[1]) - 1, cols, Number(position[2]));
}

export function parseClaudeHerdrComposer(ansi: string, cols: number): ClaudeComposer | null {
  const lines = ansi.split(/\r?\n/);
  let index = lines.length - 1;
  while (index >= 0 && !lines[index]?.startsWith("❯\u00a0")) index--;
  return parseFrame(lines, index, cols);
}

function parseFrame(lines: string[], index: number, cols: number, column?: number): ClaudeComposer | null {
  const row = lines[index];
  const upper = stripVTControlCharacters(lines[index - 1] ?? "");
  const lower = stripVTControlCharacters(lines[index + 1] ?? "");
  const footer = lines.slice(index + 2).map(stripVTControlCharacters).join("\n");
  if (!row || !RULE.test(upper) || upper.length !== cols || lower !== upper || !footer.includes("(shift+tab to cycle)")) return null;
  if (!row.startsWith("❯\u00a0")) return null;
  const parts = row.slice(2).split(REVERSE);
  if (parts.length !== 2) return null;
  const cursor = parts[1]!.indexOf(RESET);
  if (cursor < 0) return null;
  const before = parts[0]!.replace(SGR, "");
  const cell = parts[1]!.slice(0, cursor);
  const after = parts[1]!.slice(cursor + RESET.length).replace(SGR, "");
  const caretColumn = 3 + [...before].reduce((width, char) => width + cellWidth(char.codePointAt(0)!), 0);
  if ((column !== undefined && column !== caretColumn) || [...cell].length !== 1) return null;
  // The paint omits a trailing space under the caret. The visible text alone cannot prove emptiness or exact restoration.
  const draft = before + (cell === " " && after === "" ? "" : cell + after);
  if (/[\p{C}\u00a0]/u.test(draft) || (draft && !draft.trim()) || /\[(?:Pasted|Image)\b/i.test(draft)) return null;
  if (3 + [...draft].reduce((width, char) => width + cellWidth(char.codePointAt(0)!), 0) >= cols) return null;
  const preceding = stripVTControlCharacters(lines.slice(1, index - 1).join("\n")).trimEnd().split("\n").at(-1) ?? "";
  const idle = !/^[✳✽✻]\s.*…/u.test(preceding.trimStart()) && !/esc to (?:interrupt|cancel)/i.test(footer);
  const stashed = /\bdraft stashed\s*$/m.test(footer);
  return { draft, caret: before.length, stashed, idle, frame: upper + "\n" + footer, rawRow: row };
}
