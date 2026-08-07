/**
 * Parses Codex CLI's TUI numbered menus off a pane screen capture: command
 * approval prompts ("Would you like to run the following command? 1. Yes,
 * proceed (y) / 2. ... / 3. No, ... (esc)"), the directory-trust dialog
 * ("1. Yes, continue / 2. No, quit"), and the two-stage `/model` picker
 * ("Select Model and Effort" then "Select Reasoning Level for <model>").
 * All four share the same shape — a `›`-cursor line followed by consecutive
 * "N. label" lines — verified empirically against a live codex-cli 0.144.5
 * TUI session, so one parser (mirroring Claude Code's parsePermissionMenu,
 * which uses `❯` instead) covers all of them.
 */

import type { PermissionChoice, PermissionMenu } from "../driver.js";

const NUMBERED_LINE_RE = /^\s*(?:›\s*)?(\d+)\.\s*(.+?)\s*$/;
const CURSOR_LINE_RE = /›\s*\d+\./;

export function parseCodexMenu(paneText: string): PermissionMenu | null {
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

/**
 * The row number the `›` cursor currently sits on, or null if no cursor line
 * is found. Used by the `/model` wizard to navigate via arrow keys instead
 * of typing a row's digit — verified empirically that typing a digit acts as
 * a combined "jump + confirm" on Codex's list screens (races through to
 * apply a default on whatever screen comes next, e.g. the reasoning-level
 * screen, before the driver gets a chance to read and answer it), whereas
 * arrow-key navigation only moves the cursor, leaving Enter as the sole
 * confirming keystroke.
 */
export function findCursorRowNum(paneText: string): number | null {
  const lines = paneText.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = CURSOR_LINE_RE.exec(lines[i]);
    if (m) {
      const numMatch = NUMBERED_LINE_RE.exec(lines[i]);
      if (numMatch) return parseInt(numMatch[1], 10);
    }
  }
  return null;
}

/** True while the pane is showing the model-name list ("Select Model and Effort"). */
export function isModelListScreen(paneText: string): boolean {
  return /Select Model and Effort/.test(paneText);
}

/** True while the pane is showing the reasoning-effort list for a chosen model. */
export function isEffortListScreen(paneText: string): boolean {
  return /Select Reasoning Level for/.test(paneText);
}

/** Extracts the bare level name from an effort-row label, e.g.
 *  "Medium (default) (current)  Balances speed ..." -> "medium", and
 *  "Extra high                  Extra high reasoning depth ..." -> "extra high".
 *  The label/description columns are separated by 2+ spaces (same layout as
 *  model rows) — splitting on "(" alone breaks for rows with no
 *  default/current tag, since the description text then gets swept in too. */
export function effortLevelKey(label: string): string {
  return label
    .split(/\s{2,}/)[0]
    .replace(/\s*\((?:default|current)\)\s*/gi, "")
    .trim()
    .toLowerCase();
}

/** Extracts the bare model name from a model-row label, e.g.
 *  "gpt-5.6-sol (current)  Latest frontier agentic coding model." -> "gpt-5.6-sol". */
export function modelNameKey(label: string): string {
  return label
    .split(/\s{2,}/)[0]
    .replace(/\s*\((?:current|default)\)\s*/gi, "")
    .trim();
}

// The TUI ends with a status line like "gpt-5.6-sol medium fast ·
// /path/to/cwd…" — a distinctive "· /"-joined marker, analogous to Claude
// Code's "ctx ... /rc" footer marker.
const FOOTER_MARKER_RE = /·\s*\S/;

export function stripCodexFooterChrome(raw: string): string {
  const lines = raw.split("\n");
  let end = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (FOOTER_MARKER_RE.test(lines[i])) {
      end = i;
      break;
    }
  }
  while (end > 0 && !lines[end - 1].trim()) end--;
  return lines.slice(0, end).join("\n").trim();
}

/** `› 1. …` / `❯ 2. …` — a numbered option with the selection marker on it. */
const SELECTED_OPTION = /^\s*[›❯>]\s*\d+\.\s+\S/m;
/** The footer these dialogs end with, which is what makes them *waiting*. */
const AWAITING_ENTER = /Press enter to (continue|confirm)/i;

/**
 * A startup dialog Codex CLI is waiting on, or null.
 *
 * Two are known, and both are hazardous to submit into:
 *
 *   Do you trust the contents of this directory?      → default is "Yes, continue"
 *   ✨ Update available! 0.146.1 -> 0.147.0            → default *runs* `brew upgrade --cask codex`
 *
 * The update one is why this isn't a list of known strings: submitting a prompt
 * into it confirmed the default and upgraded the binary out from under a running
 * session (observed). Anything with a selected numbered option and an
 * enter-to-continue footer is treated as waiting, so the next dialog upstream
 * adds doesn't silently reintroduce the bug.
 *
 * Safe to be broad here because the caller only asks when no transcript exists
 * for the pane — i.e. no turn has ever run in it, so the only thing on screen
 * is the startup UI. Ordinary approval menus arrive later, and herdr reports
 * those as `blocked` anyway.
 */
export function parseCodexStartupPrompt(paneText: string): string | null {
  if (!SELECTED_OPTION.test(paneText) || !AWAITING_ENTER.test(paneText)) return null;
  if (/Do you trust the contents of this directory\?/i.test(paneText)) {
    return "Do you trust the contents of this directory?";
  }
  if (/Update available!/i.test(paneText)) {
    return "✨ Update available!（既定の選択肢は `brew upgrade --cask codex` を実行します）";
  }
  const headline = paneText
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !/^[›❯>]?\s*\d+\./.test(l) && !AWAITING_ENTER.test(l));
  return headline ? headline.slice(0, 160) : "起動時の選択待ちダイアログ";
}
