/**
 * Parses Claude Code's TUI menus out of a pane screen capture: both
 * permission-approval menus ("Do you want to proceed? > 1. Yes / 2. ... /
 * 3. No") and AskUserQuestion menus.
 *
 * IMPORTANT (found empirically, corrects the original design): the
 * AskUserQuestion tool_use is NOT written to the session transcript while
 * the question is pending — Claude Code writes the tool_use and its
 * tool_result together, atomically, only AFTER the question is answered.
 * So there is no way to detect or read a *pending* AskUserQuestion from the
 * transcript; it must be read off the pane, exactly like a permission menu.
 * The two are told apart by the presence of a "N. Type something." row,
 * which only appears in AskUserQuestion menus.
 */

import type { AskUserQuestionOption, AskUserQuestionPaneInfo, PermissionChoice, PermissionMenu } from "../driver.js";

const NUMBERED_LINE_RE = /^\s*(?:❯\s*)?(\d+)\.\s*(.+?)\s*$/;
const CURSOR_LINE_RE = /❯\s*\d+\./;

export function permissionAnchorIndex(paneText: string): number {
  const lines = paneText.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (CURSOR_LINE_RE.test(lines[i])) return i;
  }
  return -1;
}

export function parsePermissionMenu(paneText: string): PermissionMenu | null {
  const lines = paneText.split("\n");

  let cursorIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (CURSOR_LINE_RE.test(lines[i])) {
      cursorIdx = i;
      break;
    }
  }
  if (cursorIdx === -1) return null;

  let start = cursorIdx;
  while (start - 1 >= 0 && NUMBERED_LINE_RE.test(lines[start - 1])) start--;
  let end = cursorIdx;
  while (end + 1 < lines.length && NUMBERED_LINE_RE.test(lines[end + 1])) end++;

  const choices: PermissionChoice[] = [];
  for (let i = start; i <= end; i++) {
    const m = NUMBERED_LINE_RE.exec(lines[i]);
    if (!m) continue;
    choices.push({ num: m[1], label: m[2] });
  }

  if (choices.length < 2) return null;
  for (let i = 0; i < choices.length; i++) {
    if (choices[i].num !== String(i + 1)) return null; // must be consecutive 1..n
  }

  const snippetStart = Math.max(0, start - 8);
  const snippet = lines
    .slice(snippetStart, end + 1)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { choices, snippet };
}

const TYPE_SOMETHING_RE = /^\s*(?:❯\s*)?(\d+)\.\s*Type something\.?\s*$/;
const OPTION_LINE_RE = /^\s*(?:❯\s*)?(\d+)\.\s*(?:\[([ x✔])\]\s*)?(.+?)\s*$/;
const HEADER_LINE_RE = /^\s*[☐☒]\s*(.+?)\s*$/;
const NUMBERED_START_RE = /^\s*(?:❯\s*)?\d+\./;
/**
 * The tab bar a multi-question AskUserQuestion draws above the current
 * question: `←  ☐ 配色  ☐ フォント  ✔ Submit  →`. Recognized so it can be
 * excluded — it is neither the header nor the question, and treating it as the
 * latter put that whole line in Slack where the question belonged (measured on
 * a reproduced two-question dialog).
 */
const QUESTION_TAB_BAR_RE = /[☐☒].*(?:Submit|→)|(?:←|→).*[☐☒]/;
/** A horizontal rule the TUI uses as a separator, never content. */
const RULE_LINE_RE = /^[\s─━—-]+$/;

/**
 * Line index of the row each parser anchors on, or -1.
 *
 * Exported so the driver can pick the parser whose anchor sits *lowest* on the
 * screen rather than trying them in a fixed order. A pane read wide enough for a
 * tall dialog also holds already-answered ones above it, and each parser
 * anchoring on the last row *of its own kind* is not enough: a stale classic
 * dialog above a live preview one still gave the classic parser something to
 * find, and being tried first it won.
 */
export function classicAnchorIndex(paneText: string): number {
  const lines = paneText.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (TYPE_SOMETHING_RE.test(lines[i])) return i;
  }
  return -1;
}

/** Returns null if this pane text isn't showing an AskUserQuestion menu. */
export function parseAskUserQuestionPane(paneText: string): AskUserQuestionPaneInfo | null {
  const lines = paneText.split("\n");

  // The *last* one on screen: a pane read wide enough to hold a tall dialog can
  // also still hold an older, already-answered one, and the live dialog is
  // always the bottom-most. Anchoring on the first would parse the dead one.
  let typeSomethingIdx = -1;
  let typeSomethingNum = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = TYPE_SOMETHING_RE.exec(lines[i]);
    if (m) {
      typeSomethingIdx = i;
      typeSomethingNum = parseInt(m[1], 10);
      break;
    }
  }
  if (typeSomethingIdx === -1) return null;

  // Options first, then the question. The old order — question, then options
  // after it — meant option 1's own line was skipped whenever the question
  // wasn't where it guessed, and the result still passed validation because
  // `Array.prototype.some` walks past holes in a sparse array: a dialog came
  // back with a null first option and one of the descriptions as its question.
  const expected = typeSomethingNum - 1;
  if (expected < 1) return null;

  // Walked upward from the anchor and stopped at option 1, so only the dialog on
  // screen is read. Scanning the whole window instead meant a stale multi-select
  // question above the live one turned `multiSelect` on and never off, and the
  // live single-select question then got no buttons at all.
  const optionIdx: number[] = [];
  const options: AskUserQuestionOption[] = [];
  let multiSelect = false;
  for (let i = typeSomethingIdx - 1; i >= 0; i--) {
    const m = OPTION_LINE_RE.exec(lines[i]);
    if (!m) continue;
    const num = parseInt(m[1], 10);
    if (num < 1 || num > expected) continue;
    if (options[num - 1] !== undefined) continue; // nearest the anchor wins
    if (m[2] !== undefined) multiSelect = true;

    let description = "";
    for (let j = i + 1; j < typeSomethingIdx; j++) {
      if (NUMBERED_START_RE.test(lines[j]) || !lines[j].trim()) break;
      description += (description ? " " : "") + lines[j].trim();
    }
    options[num - 1] = { label: m[3], description: description || undefined };
    optionIdx[num - 1] = i;
    if (num === 1) break;
  }
  // Explicit index check, not `.some()`, for the sparse-array reason above.
  for (let i = 0; i < expected; i++) {
    if (options[i] === undefined) return null;
  }

  const firstOptionIdx = optionIdx[0];
  const isProse = (line: string): boolean =>
    line.trim().length > 0 &&
    !NUMBERED_START_RE.test(line) &&
    !QUESTION_TAB_BAR_RE.test(line) &&
    !RULE_LINE_RE.test(line) &&
    !HEADER_LINE_RE.test(line);

  // Nearest prose line above the first option — the question sits directly
  // above its options in every layout measured.
  let question = "";
  for (let i = firstOptionIdx - 1; i >= 0; i--) {
    if (isProse(lines[i])) {
      question = lines[i].trim();
      break;
    }
  }

  let header = "質問";
  for (let i = firstOptionIdx; i >= 0; i--) {
    if (QUESTION_TAB_BAR_RE.test(lines[i])) continue;
    const m = HEADER_LINE_RE.exec(lines[i]);
    if (m) {
      header = m[1];
      break;
    }
  }

  return { header, question, options, multiSelect };
}

/**
 * Signatures of the renderer Claude Code uses when any of a question's options
 * carries a `preview`: the option list moves to a narrow left column and the
 * preview is drawn in a box beside it. Chosen per question, so one dialog can
 * show this for one question and the classic list for the next (measured).
 *
 * There is no numbered "Type something." row here — the free-text row is an
 * unnumbered "Chat about this" — which is why the classic parser bails on it,
 * and why this needs its own terminator.
 */
const CHAT_ROW_RE = /^\s*(?:\d+\.\s*)?Chat about this\s*$/;
const NOTES_ROW_RE = /Notes:|press n to add notes/;
/** Left edge of the preview box. Deliberately excludes `─`, which also draws
 *  the full-width separator rules and can appear in preview content. */
const BOX_EDGE_RE = /[┌│└├┐┘┤]/;
/**
 * Rejoins a label the narrow column wrapped, restoring the separator the wrap
 * consumed — or not, when there was none.
 *
 * Japanese wraps mid-word, so "落ち着いたネイビー＆アイ" + "ボリーを基調にした" is one
 * word and must be joined flush. Latin text wraps at spaces, and joining flush
 * there produced "Long optionlabel" — a label that no longer matched the one the
 * agent offered.
 */
function joinWrapped(sofar: string, next: string): string {
  const needsSpace = /[A-Za-z0-9)\]}.,;:!?]$/.test(sofar) && /^[A-Za-z0-9(\[{"']/.test(next);
  return (needsSpace ? " " : "") + next;
}

/** A wrapped continuation of the option above: indented, unnumbered, non-empty. */
const CONTINUATION_RE = /^\s{2,}\S/;

/**
 * Reads the preview renderer's option list.
 *
 * The screen cannot be parsed line-by-line as-is: a label too long for the
 * narrow column wraps onto following lines, and every one of those lines also
 * carries a slice of the preview box, so the two columns are interleaved. The
 * fix is to cut each line at the box's left edge before reading anything, which
 * is index-based and so unaffected by the wide characters that make display
 * columns and string offsets disagree.
 *
 * Returns null when the pane is not showing this renderer, leaving the classic
 * parser and the permission path untouched.
 */
export function previewAnchorIndex(paneText: string): number {
  const lines = paneText.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (CHAT_ROW_RE.test(lines[i]) || NOTES_ROW_RE.test(lines[i])) return i;
  }
  return -1;
}

export function parsePreviewQuestionPane(paneText: string): AskUserQuestionPaneInfo | null {
  const raw = paneText.split("\n");
  if (!raw.some((l) => CHAT_ROW_RE.test(l))) return null;

  // Cut the preview column away. A line that was nothing but preview becomes
  // blank, which is exactly what ends a wrapped label.
  const lines = raw.map((line) => {
    const edge = line.search(BOX_EDGE_RE);
    return (edge === -1 ? line : line.slice(0, edge)).replace(/\s+$/, "");
  });

  // Bound to the dialog on screen, not the first one in the window: the read has
  // to be wide enough for a tall preview box, which means it can also still hold
  // an older dialog above. Anchor on the last of this renderer's rows, then walk
  // *up* to the option block and stop at option 1.
  let limit = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (CHAT_ROW_RE.test(lines[i]) || NOTES_ROW_RE.test(lines[i])) {
      limit = i;
      break;
    }
  }
  if (limit === -1) return null;

  const found: { num: number; idx: number; label: string }[] = [];
  for (let i = limit - 1; i >= 0 && found.length === 0; i--) {
    if (!OPTION_LINE_RE.test(lines[i])) continue;
    // First option line met walking up is the last of the block; collect the
    // whole block from here downwards so wrapped labels read in order.
    for (let j = i; j >= 0; j--) {
      const m = OPTION_LINE_RE.exec(lines[j]);
      if (!m) continue;
      const num = parseInt(m[1], 10);
      let label = m[3].trim();
      for (let k = j + 1; k < limit; k++) {
        if (!lines[k].trim() || NUMBERED_START_RE.test(lines[k]) || !CONTINUATION_RE.test(lines[k])) break;
        label += joinWrapped(label, lines[k].trim());
      }
      found.unshift({ num, idx: j, label });
      if (num === 1) break;
    }
  }
  const options: AskUserQuestionOption[] = [];
  for (let i = 0; i < found.length; i++) {
    if (found[i].num !== i + 1) return null; // must run 1..n in order
    options.push({ label: found[i].label });
  }
  const firstOptionIdx = found.length > 0 ? found[0].idx : -1;
  if (options.length < 2 || firstOptionIdx === -1) return null;

  let question = "";
  for (let i = firstOptionIdx - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.trim() || NUMBERED_START_RE.test(line) || QUESTION_TAB_BAR_RE.test(line) || RULE_LINE_RE.test(line)) {
      continue;
    }
    question = line.trim();
    break;
  }

  // Previews are single-select only, so there are no checkboxes to read.
  return { header: "質問", question, options, multiSelect: false };
}

/**
 * The four permission/plan modes Claude Code cycles through with Shift+Tab,
 * in ring order (each Shift+Tab advances to the next; wraps around). The
 * `footer` regexes match the mode-status line at the very bottom of the TUI
 * (e.g. "⏸ plan mode on (shift+tab to cycle)", "⏵⏵ accept edits on ...").
 */
export type CctagMode = "manual" | "accept-edits" | "plan" | "auto";

export const MODE_RING: readonly CctagMode[] = ["manual", "accept-edits", "plan", "auto"];

const MODE_FOOTER_RE: Record<CctagMode, RegExp> = {
  manual: /manual mode on/i,
  "accept-edits": /accept edits on/i,
  plan: /plan mode on/i,
  auto: /auto mode on/i,
};

/** The names accepted from Slack (`@cctag mode <name>`), mapped to CctagMode. */
export const MODE_ALIASES: Record<string, CctagMode> = {
  manual: "manual",
  normal: "manual",
  default: "manual",
  "accept-edits": "accept-edits",
  acceptedits: "accept-edits",
  accept: "accept-edits",
  edits: "accept-edits",
  plan: "plan",
  auto: "auto",
};

/** Reads the current mode off the pane footer, or null if none matches. */
export function parseCurrentMode(paneText: string): CctagMode | null {
  // Scan from the bottom — the mode line is the last non-blank footer line.
  const lines = paneText.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    for (const mode of MODE_RING) {
      if (MODE_FOOTER_RE[mode].test(line)) return mode;
    }
  }
  return null;
}

/** Shift+Tab (backtab) as a raw terminal control sequence — see HerdrClient.paneSendText. */
export const BACKTAB = "\x1b[Z";

/**
 * Claude Code's ExitPlanMode approval prompt prints the plan's file path in
 * its footer, e.g. "ctrl+g to edit in Vim · ~/.claude/plans/<slug>.md".
 * Returns the path of the *current* prompt — the bottom-most match, since a
 * pane read includes scrollback and an already-resolved plan prompt's path
 * may still be present higher up. Returns null if none.
 */
const PLAN_PATH_RE = /(~?\/[^\s·]*\/plans\/[^\s·]+\.md)/;

export function parsePlanFilePath(paneText: string): string | null {
  const lines = paneText.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = PLAN_PATH_RE.exec(lines[i]);
    if (m) return m[1];
  }
  return null;
}

const TELL_CLAUDE_RE = /^\s*(?:❯\s*)?(\d+)\.\s*Tell Claude what to change/;

/**
 * The ExitPlanMode approval prompt is distinguished from an ordinary
 * tool-permission menu by its "Tell Claude what to change" free-text option.
 * Returns that option's number, or null.
 *
 * Scans only the *active* prompt region — from the bottom-most `❯`-cursor
 * line to the end of the pane — for two reasons: (1) a "Tell Claude what to
 * change" line left in scrollback by an earlier, already-resolved plan
 * prompt sits above the current cursor and is thus excluded, so it can't
 * misclassify a later ordinary permission prompt; (2) it doesn't rely on
 * parsePermissionMenu's strict consecutive-numbered scan, which a narrow
 * pane can cut short when an earlier option's label wraps onto a second
 * line — dropping option 4 before it's reached.
 */
export function findPlanFeedbackOption(paneText: string): number | null {
  const lines = paneText.split("\n");
  let cursorIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (CURSOR_LINE_RE.test(lines[i])) {
      cursorIdx = i;
      break;
    }
  }
  const from = cursorIdx === -1 ? 0 : cursorIdx;
  for (let i = from; i < lines.length; i++) {
    const m = TELL_CLAUDE_RE.exec(lines[i]);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

/**
 * The TUI always ends with a fixed ~7-line footer (a separator, an empty
 * prompt, another separator, then model/context/cwd/mode status lines) plus
 * a variable amount of blank padding above it. A small `--lines N` read off
 * the bottom lands entirely inside that footer, missing the actual command
 * output higher up — so read a larger chunk and strip the footer/padding
 * off the end instead of trusting a short tail read.
 */
export function stripFooterChrome(raw: string): string {
  const lines = raw.split("\n");
  // The model/context status line ("Sonnet 5 │ ctx ▒▒▒ ... /rc") is a
  // distinctive marker for the start of the fixed ~4-line footer (it's
  // always followed by a usage-window line, the cwd basename, and a mode
  // line — none of which are reliably pattern-matchable on their own, e.g.
  // the cwd line is arbitrary text). Find its last occurrence and cut
  // everything from there to the end in one shot, then also drop the
  // separator/empty-prompt/separator directly above it and any blank
  // padding above that.
  let end = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/ctx\s.*\/rc/.test(lines[i])) {
      end = i;
      break;
    }
  }
  while (end > 0 && (/^[─\s]*$/.test(lines[end - 1]) || /^❯\s*$/.test(lines[end - 1].trim()))) end--;
  while (end > 0 && !lines[end - 1].trim()) end--;
  return lines.slice(0, end).join("\n").trim();
}

/**
 * A startup dialog Claude Code is waiting on, or null. Same shape and same
 * reasoning as the Codex equivalent (see parseCodexStartupPrompt): a selected
 * numbered option plus an enter-to-confirm footer, only ever consulted for a
 * pane no turn has run in.
 *
 * The known one is the folder-trust check:
 *   Quick safety check: Is this a project you created or one you trust?
 *   ❯ 1. Yes, I trust this folder / 2. No, exit
 */
export function parseClaudeStartupPrompt(paneText: string): string | null {
  if (!/^\s*[›❯>]\s*\d+\.\s+\S/m.test(paneText)) return null;
  if (!/Enter to confirm|Press enter to (continue|confirm)/i.test(paneText)) return null;
  if (/Is this a project you created or one you trust\?/i.test(paneText)) {
    return "Is this a project you created or one you trust?";
  }
  const headline = paneText
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !/^[›❯>]?\s*\d+\./.test(l) && !/Enter to confirm|Press enter/i.test(l));
  return headline ? headline.slice(0, 160) : "起動時の選択待ちダイアログ";
}
