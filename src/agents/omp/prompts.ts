import { createHash } from "node:crypto";
import type { ScreenSnapshot } from "../../backend/types.js";

export type OmpScreenClass = "idle" | "working" | "waiting";

interface BottomComposerFrame {
  headerIndex: number;
  header: string;
  input: string;
}

function screenRows(text: string): string[] {
  const rows = text.split(/\r?\n/u);
  while (rows.length > 0 && rows[rows.length - 1]?.trim() === "") rows.pop();
  return rows;
}

function bottomComposerFrame(rows: string[]): BottomComposerFrame | null {
  const footerIndex = rows.length - 1;
  if (footerIndex < 1) return null;

  const footer = rows[footerIndex]?.trim() ?? "";
  const footerMatch = footer.match(/^╰─(.*?)─╯$/u);
  if (!footerMatch) return null;

  const headerIndex = footerIndex - 1;
  const header = rows[headerIndex]?.trim() ?? "";
  if (!isIdleComposerHead(header) && !isWorkingComposerHead(header)) return null;

  return { headerIndex, header, input: footerMatch[1] ?? "" };
}

function hasOpenFrameAbove(rows: string[], beforeIndex: number): boolean {
  let openFrames = 0;
  for (let index = 0; index < beforeIndex; index++) {
    const row = rows[index]?.trimStart() ?? "";
    if (row.startsWith("╭─")) {
      openFrames++;
    } else if (row.startsWith("╰─") && openFrames > 0) {
      openFrames--;
    }
  }
  return openFrames > 0;
}

function isWorkingStatusRow(row: string): boolean {
  return /^⎋\s*Working(?:…|\.{3})(?:\s|$)/u.test(row.trim());
}

function isWorkingComposerHead(header: string): boolean {
  return /^╭──\s+\S+\s+\d+(?:\.\d+)?s\s*>/u.test(header);
}

function isIdleComposerHead(header: string): boolean {
  return /^╭──\s*π\s*>/u.test(header);
}

const THINKING_EFFORT_HINT = "⇧⇥ to change thinking effort";
export const OMP_WAITING_NOTICE = "omp が入力を待っています。端末で答えてください";

// Ignore only the captured hint at the footer's right edge; other input remains a draft.
function composerInputWithoutUiHint(input: string): string {
  const hintStart = input.indexOf(THINKING_EFFORT_HINT);
  if (
    hintStart <= 0 ||
    input.length - hintStart !== THINKING_EFFORT_HINT.length + 1 ||
    input[input.length - 1] !== " "
  ) {
    return input;
  }
  for (let index = 0; index < hintStart; index++) {
    if (input[index] !== " ") return input;
  }
  return "";
}

function hasDraft(snapshot: ScreenSnapshot, frame: BottomComposerFrame): boolean {
  return (
    composerInputWithoutUiHint(frame.input).trim().length > 0 ||
    (snapshot.draft !== null && snapshot.draft.trim().length > 0)
  );
}

export function classifyOmpScreen(snapshot: ScreenSnapshot): OmpScreenClass | null {
  if (!snapshot.complete) return null;

  const rows = screenRows(snapshot.text);
  if (rows.some(isWorkingStatusRow)) return "working";

  const frame = bottomComposerFrame(rows);
  if (frame && isWorkingComposerHead(frame.header)) return "working";
  if (
    frame &&
    isIdleComposerHead(frame.header) &&
    !hasDraft(snapshot, frame) &&
    !hasOpenFrameAbove(rows, frame.headerIndex)
  ) {
    return "idle";
  }
  return "waiting";
}

export function isOmpIdleComposer(snapshot: ScreenSnapshot): boolean {
  return classifyOmpScreen(snapshot) === "idle";
}

export function ompScreenBody(snapshot: ScreenSnapshot): string | null {
  if (!snapshot.complete) return null;

  const rows = screenRows(snapshot.text);
  const frame = bottomComposerFrame(rows);
  if (frame) rows.splice(frame.headerIndex, 2);
  return rows.join("\n");
}

export function formatOmpScreenNotice(snapshot: ScreenSnapshot): string | null {
  const body = ompScreenBody(snapshot);
  if (body === null) return null;
  return body.length > 0 ? `${body}\n\n${OMP_WAITING_NOTICE}` : OMP_WAITING_NOTICE;
}

export function ompScreenFingerprint(snapshot: ScreenSnapshot): string | null {
  const body = ompScreenBody(snapshot);
  return body === null ? null : createHash("sha256").update(body, "utf8").digest("hex");
}
