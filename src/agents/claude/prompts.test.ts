import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAskUserQuestionPane, parsePreviewQuestionPane } from "./prompts.js";
import { claudeDriver } from "./driver.js";

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

// --- the preview renderer -----------------------------------------------------
// Captured verbatim from a pane while a two-question dialog was up, first
// question carrying previews. The label of option 1 wrapped across three lines
// and every one of those lines also carries a slice of the preview box, which is
// what the classic parser cannot survive. Parsed labels were checked against the
// tool input recorded in the transcript afterwards and match it exactly.
const PREVIEW_PANE = [
  "←  ☐ 配色  ☐ フォント  ✔ Submit  →",
  "",
  "配色はどちらにしますか？",
  "",
  "❯ 1. 落ち着いたネイビー＆アイ     ┌─────────────────────────────────────────────────────────────┐",
  "    ボリーを基調にした学術的な    │ 背景色: #F7F5EF (アイボリー)                                │",
  "    配色                          │ メインアクセント: #1F3A5F (ネイビー)                        │",
  "  2. 明るいティール＆コーラル     │ サブアクセント: #8C7A5B (くすみゴールド)                    │",
  "    のコントラスト配色            │ テキスト: #23272B (ほぼ黒)                                  │",
  "                                  │                                                             │",
  "                                  │ 用途イメージ:                                               │",
  "                                  │ - 見出し: ネイビー地に白文字                                │",
  "                                  └─────────────────────────────────────────────────────────────┘",
  "",
  "                                  Notes: press n to add notes",
  "",
  "─".repeat(120),
  "  Chat about this",
  "",
  "Enter to select · ↑/↓ to navigate · n to add notes · Tab to switch questions · Esc to cancel",
].join("\n");

test("the preview renderer's wrapped labels are rejoined and the preview column dropped", () => {
  const info = parsePreviewQuestionPane(PREVIEW_PANE);
  assert.ok(info, "this is the shape that reached Slack as a raw screen dump");
  assert.equal(info.question, "配色はどちらにしますか？");
  assert.deepEqual(
    info.options.map((o) => o.label),
    ["落ち着いたネイビー＆アイボリーを基調にした学術的な配色", "明るいティール＆コーラルのコントラスト配色"],
    "verified against the AskUserQuestion input the transcript recorded for this very dialog",
  );
  assert.equal(info.multiSelect, false, "previews are single-select only");
});

test("the classic parser still refuses the preview renderer, so the two do not fight", () => {
  // There is no numbered "Type something." row in this renderer — the free-text
  // row is an unnumbered "Chat about this" — which is precisely why it needs its
  // own parser rather than a loosened classic one.
  assert.equal(parseAskUserQuestionPane(PREVIEW_PANE), null);
});

test("the preview parser refuses a classic dialog, so ordering cannot break it", () => {
  const classic = ["☐ 実装方針", "", "どの方式で？", "", "❯ 1. A方式", "  2. B方式", "  3. Type something."].join("\n");
  assert.equal(parsePreviewQuestionPane(classic), null);
});

test("a permission menu is not mistaken for a preview question", () => {
  const permission = [
    "Bash command",
    "",
    "  rm -rf build/",
    "",
    "Do you want to proceed?",
    "❯ 1. Yes",
    "  2. No",
    "",
    "Esc to cancel · Tab to amend",
  ].join("\n");
  assert.equal(parsePreviewQuestionPane(permission), null, "no Chat about this row means this is not that renderer");
});

// --- answering, which differs by renderer -------------------------------------

/** Records what was sent, and lets the test decide what the pane shows next. */
function fakeHerdr(paneAfterDigit: () => string): {
  herdr: Parameters<NonNullable<typeof claudeDriver.answerQuestionOption>>[0];
  sent: string[];
} {
  const sent: string[] = [];
  const herdr = {
    async agentSend(_p: string, text: string) {
      sent.push(`text:${text}`);
    },
    async paneSendKeys(_p: string, ...keys: string[]) {
      sent.push(...keys.map((k) => `key:${k}`));
    },
    async paneRead() {
      return paneAfterDigit();
    },
  } as unknown as Parameters<NonNullable<typeof claudeDriver.answerQuestionOption>>[0];
  return { herdr, sent };
}

const PREVIEW_INFO = { header: "質問", question: "配色はどちらにしますか？", options: [], multiSelect: false };

test("the preview renderer gets the Enter its digit does not supply", async () => {
  // Measured: in this renderer a digit only moves the cursor. Without the Enter
  // the dialog just sits there with a different option highlighted.
  const { herdr, sent } = fakeHerdr(() => PREVIEW_PANE);
  await claudeDriver.answerQuestionOption!(herdr, "w0:p1", 2, PREVIEW_INFO);
  assert.deepEqual(sent, ["text:2", "key:Enter"]);
});

test("the classic renderer gets no Enter, which would answer the next question", async () => {
  // Measured: there a digit selects and confirms, and the dialog has already
  // advanced by the time we look — so a trailing Enter would confirm whatever is
  // highlighted on the question that replaced it.
  const nextQuestion = ["単位系はどちらにしますか？", "", "❯ 1. SI単位系", "  2. ヤード・ポンド法", "  3. Type something."].join("\n");
  const { herdr, sent } = fakeHerdr(() => nextQuestion);
  await claudeDriver.answerQuestionOption!(herdr, "w0:p1", 1, PREVIEW_INFO);
  assert.deepEqual(sent, ["text:1"], "the digit alone");
});

test("landing on the submit menu also gets no Enter", async () => {
  const submitMenu = ["Ready to submit your answers?", "❯ 1. Submit answers", "  2. Cancel"].join("\n");
  const { herdr, sent } = fakeHerdr(() => submitMenu);
  await claudeDriver.answerQuestionOption!(herdr, "w0:p1", 1, PREVIEW_INFO);
  assert.deepEqual(sent, ["text:1"]);
});

test("a different preview question on screen gets no Enter either", async () => {
  // Same renderer, but a *different* question means the digit confirmed and
  // advanced; the identity check is what tells those two cases apart.
  const other = PREVIEW_PANE.replace("配色はどちらにしますか？", "フォントはどちらにしますか？");
  const { herdr, sent } = fakeHerdr(() => other);
  await claudeDriver.answerQuestionOption!(herdr, "w0:p1", 1, PREVIEW_INFO);
  assert.deepEqual(sent, ["text:1"]);
});
