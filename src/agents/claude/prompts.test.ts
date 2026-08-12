import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAskUserQuestionPane } from "./prompts.js";

// Fixtures taken from a real pane. A two-question AskUserQuestion was raised on
// purpose — one question with option previews, one without — because that shape
// is what a live session hit and cctag mis-read. Claude Code picks the renderer
// per question: previews give the side-by-side layout, and a question without
// them draws the classic list, so both appear in one dialog.

const FONT_OPTIONS = [
  "❯ 1. Sans-serif（ゴシック体系）",
  "     視認性が高く、スクリーン表示向き",
  "  2. Serif（明朝体系）",
  "     文字数が多い文書や印刷物に向く",
  "  3. Monospace系",
  "     コードやデータを多く含む内容に向く",
  "  4. Type something.",
  "─".repeat(80),
  "  5. Chat about this",
];

const WITH_TAB_BAR = [
  "←  ☐ 配色  ☐ フォント  ✔ Submit  →",
  "",
  "フォントはどれにしますか？",
  "",
  ...FONT_OPTIONS,
];

test("every option is read, including the first", () => {
  // The measured failure: option 1 came back as a hole and validation let it
  // through, because `Array.prototype.some` walks straight past holes in a
  // sparse array. Slack would then have offered a button labelled "null".
  const info = parseAskUserQuestionPane(FONT_OPTIONS.join("\n"));
  assert.ok(info, "this is a well-formed question list and must parse");
  assert.deepEqual(
    info.options.map((o) => o.label),
    ["Sans-serif（ゴシック体系）", "Serif（明朝体系）", "Monospace系"],
  );
  assert.equal(info.options[0].description, "視認性が高く、スクリーン表示向き");
});

test("a description is never mistaken for the question", () => {
  // Same measurement: with the question outside the captured window, the first
  // option's description was promoted to being the question.
  const info = parseAskUserQuestionPane(FONT_OPTIONS.join("\n"));
  assert.equal(info?.question, "", "no question in view is better than the wrong one");
});

test("the multi-question tab bar is not read as the question", () => {
  // With the tab bar present the whole `←  ☐ 配色  ☐ フォント  ✔ Submit  →` line
  // was posted to Slack as the question text, and the real question dropped.
  const info = parseAskUserQuestionPane(WITH_TAB_BAR.join("\n"));
  assert.equal(info?.question, "フォントはどれにしますか？");
  assert.equal(
    info?.options.length,
    3,
    "the tab bar's own ☐ marks must not be counted as options either",
  );
});

test("the ordinary single-question dialog still parses as it did", () => {
  const info = parseAskUserQuestionPane(
    ["☐ 実装方針", "", "どの方式で進めますか？", "", "❯ 1. A方式", "  2. B方式", "  3. Type something."].join("\n"),
  );
  assert.equal(info?.header, "実装方針");
  assert.equal(info?.question, "どの方式で進めますか？");
  assert.deepEqual(info?.options.map((o) => o.label), ["A方式", "B方式"]);
  assert.equal(info?.multiSelect, false);
});

test("a multiSelect dialog is still recognized as one", () => {
  const info = parseAskUserQuestionPane(
    ["☒ 機能", "", "どれを含めますか？", "", "❯ 1. [x] ログ", "  2. [ ] 通知", "  3. Type something."].join("\n"),
  );
  assert.equal(info?.multiSelect, true, "the checkbox marks are what distinguish it");
  assert.deepEqual(info?.options.map((o) => o.label), ["ログ", "通知"]);
});

test("a pane with a gap in its option numbers is refused outright", () => {
  // Better to fall back than to post a prompt with a missing choice.
  const info = parseAskUserQuestionPane(
    ["どれ？", "", "❯ 1. A", "  3. C", "  4. Type something."].join("\n"),
  );
  assert.equal(info, null);
});

test("a pane showing no question dialog at all parses as none", () => {
  assert.equal(parseAskUserQuestionPane("❯ \n  just a prompt box\n"), null);
});
