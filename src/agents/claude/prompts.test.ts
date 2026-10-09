import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  classicDialogState,
  looksLikeQuestionScreen,
  parseAskUserQuestionPane,
  parseCursorLabel,
  parsePreviewQuestionPane,
  previewAnchorIndex,
} from "./prompts.js";
import { claudeDriver } from "./driver.js";
import { stripSidePane } from "../../backend/side-pane.js";
import type { AnswerChannel, Terminals } from "../../backend/index.js";
import type { AgentRef, ScreenSnapshot } from "../../backend/types.js";
import { ExpectationLost } from "../../backend/types.js";

const TEST_REF: AgentRef = { target: "w0:p1", pid: null, processStartedAt: null };

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
function fakeHerdr(
  paneAfterDigit: () => string,
  readPane: () => string | Promise<string> = paneAfterDigit,
  initialPrompt = PREVIEW_PANE,
): { herdr: Terminals; channel: AnswerChannel; sent: string[] } {
  const sent: string[] = [];
  const channel: AnswerChannel = {
    async digit(n) {
      sent.push(`text:${n}`);
    },
    async text(value) {
      sent.push(`text:${value}`);
    },
    async move(direction, count) {
      sent.push(...Array(count).fill(`key:${direction}`));
    },
    async confirm() {
      sent.push("key:Enter");
    },
    complete() {},
  };
  const herdr: Terminals = {
    async list() {
      return { agents: [], failures: [], complete: true, notices: [] };
    },
    async get() {
      return null;
    },
    async exists() {
      return true;
    },
    async read() {
      return { text: await readPane(), draft: null, complete: true };
    },
    async submit() {
      return { status: "accepted", draftStashed: false };
    },
    openAnswer() {
      return channel;
    },
    openModelAnswer() {
      return {
        ...channel,
        async escape() {
          sent.push("key:Escape");
        },
      };
    },
    openBlind() {
      return { async answer() {} };
    },
    openComposer() {
      return { async backTab() {} };
    },
  };
  const prompt = claudeDriver.parseBlockedPane(initialPrompt);
  if (prompt.kind !== "question") throw new Error(`expected question fixture, got ${prompt.kind}`);
  return { herdr, channel: herdr.openAnswer(TEST_REF, prompt.verified), sent };
}

const PREVIEW_LABELS = [
  "落ち着いたネイビー＆アイボリーを基調にした学術的な配色",
  "明るいティール＆コーラルのコントラスト配色",
];
const PREVIEW_INFO = {
  header: "質問",
  question: "配色はどちらにしますか？",
  options: PREVIEW_LABELS.map((label) => ({ label })),
  multiSelect: false,
};

test("the preview renderer gets the Enter its digit does not supply", async () => {
  // Measured: in this renderer a digit only moves the cursor. Without the Enter
  // the dialog just sits there with a different option highlighted.
  const { herdr, channel, sent } = fakeHerdr(() => PREVIEW_PANE);
  await claudeDriver.answerQuestionOption!(herdr, channel, "w0:p1", 2, PREVIEW_INFO);
  assert.deepEqual(sent, ["text:2", "key:Enter"]);
});

test("the classic renderer gets no Enter, which would answer the next question", async () => {
  // Measured: there a digit selects and confirms, and the dialog has already
  // advanced by the time we look — so a trailing Enter would confirm whatever is
  // highlighted on the question that replaced it.
  const nextQuestion = ["単位系はどちらにしますか？", "", "❯ 1. SI単位系", "  2. ヤード・ポンド法", "  3. Type something."].join("\n");
  const { herdr, channel, sent } = fakeHerdr(() => nextQuestion);
  await claudeDriver.answerQuestionOption!(herdr, channel, "w0:p1", 1, PREVIEW_INFO);
  assert.deepEqual(sent, ["text:1"], "the digit alone");
});

test("landing on the submit menu also gets no Enter", async () => {
  const submitMenu = ["Ready to submit your answers?", "❯ 1. Submit answers", "  2. Cancel"].join("\n");
  const { herdr, channel, sent } = fakeHerdr(() => submitMenu);
  await claudeDriver.answerQuestionOption!(herdr, channel, "w0:p1", 1, PREVIEW_INFO);
  assert.deepEqual(sent, ["text:1"]);
});

test("a different preview question on screen gets no Enter either", async () => {
  // Same renderer, but a *different* question means the digit confirmed and
  // advanced; the identity check is what tells those two cases apart.
  const other = PREVIEW_PANE.replace("配色はどちらにしますか？", "フォントはどちらにしますか？");
  const { herdr, channel, sent } = fakeHerdr(() => other);
  await claudeDriver.answerQuestionOption!(herdr, channel, "w0:p1", 1, PREVIEW_INFO);
  assert.deepEqual(sent, ["text:1"]);
});

test("a following question that repeats the wording does not inherit the Enter", async () => {
  // Codex re-review round 3, Critical 2. Comparing the question text alone meant a
  // next question phrased identically looked like the one just answered, and took
  // an Enter that confirmed *its* default option.
  const sameWordingDifferentOptions = PREVIEW_PANE.replace(
    "  2. 明るいティール＆コーラル     │ サブアクセント: #8C7A5B (くすみゴールド)                    │",
    "  2. 全く別の選択肢               │ サブアクセント: #8C7A5B (くすみゴールド)                    │",
  );
  const { herdr, channel, sent } = fakeHerdr(() => sameWordingDifferentOptions);
  await claudeDriver.answerQuestionOption!(herdr, channel, "w0:p1", 1, PREVIEW_INFO);
  assert.deepEqual(sent, ["text:1"], "different options mean a different question");
});

test("a cancelled pane gets the digit but never the confirming Enter", async () => {
  // Codex re-review round 3, Critical 3. This runs outside the poll loop, which
  // releases the pane as soon as it is asked to stop — so by the time the Enter
  // would be sent, something else may hold the pane.
  const { herdr, channel, sent } = fakeHerdr(() => PREVIEW_PANE);
  const controller = new AbortController();
  controller.abort();
  await claudeDriver.answerQuestionOption!(herdr, channel, "w0:p1", 2, PREVIEW_INFO, controller.signal);
  assert.deepEqual(sent, ["text:2"], "no keystroke may follow the release");
});

test("a failed re-read is reported, not treated as answered", async () => {
  // Codex re-review round 3, Critical 4. Swallowing it meant no Enter was sent
  // while the caller marked the Slack prompt answered — the pane stayed waiting
  // and the same prompt came back on the next poll.
  const { herdr, channel } = fakeHerdr(
    () => "",
    async () => {
      throw new Error("herdr command timed out");
    },
  );
  await assert.rejects(
    claudeDriver.answerQuestionOption!(herdr, channel, "w0:p1", 1, PREVIEW_INFO),
    /herdr command timed out/,
  );
});

test("the live dialog is the lowest one, not the first parser to match", async () => {
  // Codex re-review round 3, Critical 1. A stale classic dialog above a live
  // preview question used to win simply because its parser ran first.
  const stalePlusLive = [
    "☐ 古い質問",
    "",
    "これは既に回答済みの質問です",
    "",
    "❯ 1. 古い選択肢A",
    "  2. 古い選択肢B",
    "  3. Type something.",
    "",
    PREVIEW_PANE,
  ].join("\n");
  const prompt = claudeDriver.parseBlockedPane(stalePlusLive);
  assert.equal(prompt.kind, "question");
  if (prompt.kind !== "question") return;
  assert.equal(prompt.info.question, "配色はどちらにしますか？", "the live one");
  assert.deepEqual(prompt.info.options.map((o) => o.label), PREVIEW_LABELS);
});

test("a permission menu below a stale question is parsed as a permission menu", () => {
  // The other direction of the same fix: the question is gone, and its numbered
  // options must not be read as the menu that replaced it.
  const staleQuestionThenPermission = [
    PREVIEW_PANE,
    "",
    "Bash command",
    "",
    "  rm -rf build/",
    "",
    "Do you want to proceed?",
    "❯ 1. Yes",
    "  2. No",
  ].join("\n");
  const prompt = claudeDriver.parseBlockedPane(staleQuestionThenPermission);
  assert.equal(prompt.kind, "permission");
  if (prompt.kind !== "permission") return;
  assert.deepEqual(prompt.menu?.choices.map((c) => c.label), ["Yes", "No"]);
});

test("a stale multi-select question above does not strip the live one of its buttons", () => {
  // Codex re-review round 3, Moderate 1. multiSelect was turned on by any checkbox
  // anywhere in the window and never turned off, so a live single-select question
  // was posted as free-text-only.
  const staleMultiThenLive = [
    "☒ 古い質問",
    "",
    "どれを含めますか？",
    "",
    "❯ 1. [x] ログ",
    "  2. [ ] 通知",
    "  3. Type something.",
    "",
    "☐ 実装方針",
    "",
    "どの方式で進めますか？",
    "",
    "❯ 1. A方式",
    "  2. B方式",
    "  3. Type something.",
  ].join("\n");
  const info = parseAskUserQuestionPane(staleMultiThenLive);
  assert.equal(info?.question, "どの方式で進めますか？");
  assert.equal(info?.multiSelect, false, "the live question is single-select");
  assert.deepEqual(info?.options.map((o) => o.label), ["A方式", "B方式"]);
});

test("a Latin label wrapped at a space is rejoined with that space", () => {
  // Codex re-review round 3, Moderate 2. Joining flush is right for Japanese,
  // which wraps mid-word, but it ran Latin words together — the label no longer
  // matched the one the agent offered.
  const pane = [
    "Which layout?",
    "",
    "❯ 1. Long option label that     ┌────────────┐",
    "    wraps across lines          │ preview    │",
    "  2. Short one                  └────────────┘",
    "",
    "                                Notes: press n to add notes",
    "  Chat about this",
  ].join("\n");
  const info = parsePreviewQuestionPane(pane);
  assert.deepEqual(info?.options.map((o) => o.label), ["Long option label that wraps across lines", "Short one"]);
});

test("a Japanese label wrapped mid-word is still rejoined flush", () => {
  const info = parsePreviewQuestionPane(PREVIEW_PANE);
  assert.equal(info?.options[0].label, PREVIEW_LABELS[0], "no space may be introduced mid-word");
});

test("a classic dialog is not hijacked by the preview parser", () => {
  // Regression from the anchor-lowest rule, caught on a live prompt: the classic
  // list ends with a *numbered* "Chat about this" below its numbered "Type
  // something.", so accepting either form of that row made every classic dialog
  // look like a preview one — and, its chat row being lowest, win the comparison.
  // The symptoms in Slack were an extra option reading "Type something." and each
  // label glued to its own description.
  const classic = [
    "月曜の試験運用の受講者は何名くらいですか？",
    "",
    "❯ 1. 数名（関係者のみ）",
    "     コスト・負荷とも問題なし。",
    "  2. 20〜30名（1クラス）",
    "     対話コストが実測できる規模。",
    "  3. 50名以上",
    "     設計を先に確認する必要。",
    "  4. Type something.",
    "─".repeat(80),
    "  5. Chat about this",
  ].join("\n");

  assert.equal(previewAnchorIndex(classic), -1, "a numbered chat row is not this renderer's");
  const prompt = claudeDriver.parseBlockedPane(classic);
  assert.equal(prompt.kind, "question");
  if (prompt.kind !== "question") return;
  assert.equal(prompt.verified.form, "digit-confirms");
  assert.deepEqual(
    prompt.info.options.map((o) => o.label),
    ["数名（関係者のみ）", "20〜30名（1クラス）", "50名以上"],
    "three real options — the free-text row is not one of them",
  );
  assert.equal(prompt.info.options[0].description, "コスト・負荷とも問題なし。", "kept separate from the label");
});

test("the preview renderer's own unnumbered chat row still anchors it", () => {
  assert.ok(previewAnchorIndex(PREVIEW_PANE) > 0);
  const prompt = claudeDriver.parseBlockedPane(PREVIEW_PANE);
  assert.equal(prompt.kind, "question");
  if (prompt.kind !== "question") return;
  assert.equal(prompt.verified.form, "digit-then-enter");
  assert.deepEqual(prompt.info.options.map((o) => o.label), PREVIEW_LABELS);
});

// Minimal rows, copied verbatim from the live u0 captures named in u2b:
// terminal.tail rows 97-108 for the question and 94-108 for /model.
const CAPTURED_QUESTION_BEFORE_DOWN = [
  " ☐ Test color",
  "Test color: どの色を選びますか？",
  "❯ 1. amber",
  "     琥珀色。温かみのある黄橙系の色",
  "  2. cobalt",
  "     コバルトブルー。深く鮮やかな青",
  "  3. jade",
  "     翡翠色。落ち着いた青みのある緑",
  "  4. Type something.",
  "  5. Chat about this",
  "Enter to select · ↑/↓ to navigate · Esc to cancel",
].join("\n");
const CAPTURED_QUESTION_AFTER_DOWN = [
  " ☐ Test color",
  "Test color: どの色を選びますか？",
  "  1. amber",
  "     琥珀色。温かみのある黄橙系の色",
  "❯ 2. cobalt",
  "     コバルトブルー。深く鮮やかな青",
  "  3. jade",
  "     翡翠色。落ち着いた青みのある緑",
  "  4. Type something.",
  "  5. Chat about this",
  "Enter to select · ↑/↓ to navigate · Esc to cancel",
].join("\n");
const CAPTURED_MODEL_BEFORE_DOWN = [
  "   Select model",
  "   Switch between Claude models. Your pick becomes the default for new sessions. For other/previous model names, specify with --model.",
  "   ❯ 1.  Default (recommended) ✔  Opus 5.5 · Best for everyday, complex tasks",
  "     2.  Opus 5.5                 Most capable for ambitious work",
  "Enter to set as default · s to use this session only · Esc to cancel",
].join("\n");
const CAPTURED_MODEL_AFTER_DOWN = [
  "   Select model",
  "   Switch between Claude models. Your pick becomes the default for new sessions. For other/previous model names, specify with --model.",
  "     1.  Default (recommended) ✔  Opus 5.5 · Best for everyday, complex tasks",
  "   ❯ 2.  Opus 5.5                 Most capable for ambitious work",
  "Enter to set as default · s to use this session only · Esc to cancel",
].join("\n");

test("Claude cursor labels follow captured question and /model rows before and after Down", () => {
  const snapshot = (text: string) => ({ text, draft: null, complete: true });
  assert.equal(claudeDriver.parseCursorLabel(snapshot(CAPTURED_QUESTION_BEFORE_DOWN)), "amber");
  assert.equal(claudeDriver.parseCursorLabel(snapshot(CAPTURED_QUESTION_AFTER_DOWN)), "cobalt");
  assert.equal(
    claudeDriver.parseCursorLabel(snapshot(CAPTURED_MODEL_BEFORE_DOWN)),
    "Default (recommended) ✔  Opus 5.5 · Best for everyday, complex tasks",
  );
  assert.equal(
    claudeDriver.parseCursorLabel(snapshot(CAPTURED_MODEL_AFTER_DOWN)),
    "Opus 5.5                 Most capable for ambitious work",
  );
  assert.equal(
    claudeDriver.parseCursorLabel(snapshot(["────────────────────", "❯", "────────────────────", "   Opus 5.5"].join("\n"))),
    null,
    "the idle composer cursor has no selected option label",
  );
  assert.equal(claudeDriver.parseCursorLabel(snapshot("Select model\n  1. Opus\n  2. Sonnet")), null);
});

test("Claude cursor parser reads the captured unnumbered multi-select Submit row", () => {
  assert.equal(
    claudeDriver.parseCursorLabel(capturedScreen("ask-user-question-multiselect-submit-row.screen.json")),
    "Submit",
  );
});

test("Claude answer-review parser verifies complete choices and selected answers", () => {
  const review = capturedScreen("ask-user-question-multiselect-review.screen.json");
  const expected = {
    question: "Which colors belong in a harmless sample palette?",
    answers: ["Amber", "Jade"],
  };
  const verified = claudeDriver.parseAnswerReview?.(review, expected);
  assert.ok(verified);
  assert.equal(verified.form, "digit-confirms");

  const reorderedAnswers = { ...review, text: review.text.replace("Amber, Jade", "Jade, Amber") };
  assert.ok(claudeDriver.parseAnswerReview?.(reorderedAnswers, expected));
  const changedAnswers = { ...review, text: review.text.replace("Amber, Jade", "Amber, Cobalt") };
  const changedFingerprint = claudeDriver.parseAnswerReview?.(changedAnswers);
  assert.ok(changedFingerprint);
  assert.notEqual(changedFingerprint.fingerprint, verified.fingerprint);
  assert.equal(claudeDriver.parseAnswerReview?.(changedAnswers, expected), null);
  assert.equal(claudeDriver.parseAnswerReview?.({ ...review, complete: false }, expected), null);
  assert.equal(
    claudeDriver.parseAnswerReview?.(
      { ...review, text: review.text.replace("Ready to submit your answers?", "Ready to submit?") },
      expected,
    ),
    null,
  );
  assert.equal(
    claudeDriver.parseAnswerReview?.({ ...review, text: review.text.replace("\n  2. Cancel", "") }, expected),
    null,
  );
  assert.equal(
    claudeDriver.parseAnswerReview?.(
      { ...review, text: review.text.replace("❯ 1. Submit answers", "  1. Submit answers") },
      expected,
    ),
    null,
  );
});
test("Claude answer review rejects a later prompt and a Cancel cursor", () => {
  const review = capturedScreen("ask-user-question-multiselect-review.screen.json");
  const expected = {
    question: "Which colors belong in a harmless sample palette?",
    answers: ["Amber", "Jade"],
  };
  const laterQuestion = [
    " ☐ Later question",
    "Later question: choose the replacement answer?",
    "  1. Keep",
    "  2. Change",
    "  3. Type something.",
  ].join("\n");
  assert.equal(
    claudeDriver.parseAnswerReview?.({ ...review, text: `${review.text}\n${laterQuestion}` }, expected),
    null,
  );

  const cancelSelected = review.text.replace(
    "❯ 1. Submit answers\n  2. Cancel",
    "  1. Submit answers\n❯ 2. Cancel",
  );
  assert.equal(claudeDriver.parseAnswerReview?.({ ...review, text: cancelSelected }, expected), null);
});


// --- the context snippet's reach, and answering an unreadable screen --------

test("a plan prompt's snippet stops at the rule, not eight lines up", () => {
  // Taken from a live paired pane. The reach-back is eight lines from the first
  // option, which is right for a permission menu — its subject sits just above
  // the options — but a plan approval has only its question line, so the reach
  // crossed the full-width rule and pasted the agent's previous output into the
  // Slack code block. What the user saw began mid-sentence in an unrelated
  // analysis section and read as a garbled prompt.
  const pane = [
    "   F3. $\\tau$ の非同定性は rs-ecoc でも同じ壁",
    "",
    "   - ecoc_reliability_en.tex L1180–1182: 雑音分散は \"cannot be uniquely estimated from a trained",
    "     classifier's outputs on real data\"                    ↓",
    "  " + "─".repeat(120),
    "   Claude has written up a plan and is ready to execute. Would you like to proceed?",
    "",
    "   ❯ 1. Yes, and use auto mode",
    "     2. Yes, manually approve edits",
    "     3. Tell Claude what to change",
  ].join("\n");

  const prompt = claudeDriver.parseBlockedPane(pane);
  assert.equal(prompt.kind, "permission");
  if (prompt.kind !== "permission") return;
  assert.equal(prompt.verified.form, "compound");
  assert.equal(prompt.isPlanPrompt, true);
  const snippet = prompt.menu?.snippet ?? "";
  assert.ok(snippet.startsWith("Claude has written up a plan"), `snippet began with: ${snippet.slice(0, 60)}`);
  assert.ok(!snippet.includes("非同定性"), "the agent's previous output must not be pasted into the prompt");
  assert.ok(!snippet.includes("─────"), "nor the rule that bounds the prompt region");
});

test("a permission menu with no rule above it keeps its context", () => {
  // The other direction, and the reason the reach exists at all: the command
  // being asked about is what makes a permission prompt answerable.
  const pane = [
    "  Bash command",
    "",
    "  rm -rf /tmp/scratch-dir",
    "  Delete the scratch directory",
    "",
    "  Do you want to proceed?",
    "❯ 1. Yes",
    "  2. No",
  ].join("\n");

  const prompt = claudeDriver.parseBlockedPane(pane);
  assert.equal(prompt.kind, "permission");
  if (prompt.kind !== "permission") return;
  assert.equal(prompt.verified.form, "digit-confirms");
  assert.ok(prompt.menu?.snippet.includes("rm -rf /tmp/scratch-dir"), "the command must survive");
});

test("a blank line and a short dash run do not cut the context short", () => {
  // The pitfall the boundary regex is deliberately stricter than RULE_LINE_RE
  // for: that one also matches whitespace-only lines, so reusing it here would
  // have truncated every snippet at the first blank line above the options.
  const pane = [
    "  Bash command",
    "",
    "  git commit -m 'wip'",
    "  ---",
    "",
    "  Do you want to proceed?",
    "❯ 1. Yes",
    "  2. No",
  ].join("\n");

  const prompt = claudeDriver.parseBlockedPane(pane);
  assert.equal(prompt.kind, "permission");
  if (prompt.kind !== "permission") return;
  assert.ok(prompt.menu?.snippet.includes("git commit"), "a blank line is not a region boundary");
});

test("a question screen is recognizable even when its options cannot be read", () => {
  // Production incident: the second question of a three-question dialog — the
  // multi-select one — failed to parse, fell through to the permission branch,
  // and was offered ✅/❌ buttons that sent a bare `y` into a checkbox list.
  // Either marker alone has to be enough, since whatever broke the option
  // parsing may well have broken the rest of the shape too.
  assert.equal(looksLikeQuestionScreen(["  3. Type something.", "garbled"].join("\n")), true);
  assert.equal(looksLikeQuestionScreen("←  ☐ 本稿の方針  ☐ 別論文の主軸  ✔ Submit  →"), true);

  // A permission menu must NOT be mistaken for one — that path still offers
  // y/n, which an unreadable permission prompt does accept.
  assert.equal(looksLikeQuestionScreen(["  Do you want to proceed?", "❯ 1. Yes", "  2. No"].join("\n")), false);
  assert.equal(looksLikeQuestionScreen(""), false);
});

// --- multi-select, captured from a live pane -------------------------------

/**
 * A real multi-select AskUserQuestion as Claude Code 2.1.241 draws it, captured
 * from a paired pane. The single-select fixtures above were taken the same way;
 * this shape never was, and was written from assumption instead — which is how
 * it went wrong.
 *
 * The load-bearing difference is row 5: a multi-select dialog puts a checkbox on
 * EVERY row, the free-text one included, so it reads `5. [ ] Type something`
 * rather than `4. Type something.`. That row is the anchor both this parser and
 * classicAnchorIndex find the dialog by.
 */
const LIVE_MULTI_SELECT = [
  "←  ☐ 次の一手  ✔ Submit  →",
  "",
  "│ 複数選択の描画を実物で確認できたとして、この件はどこまで進めますか。該当するものを選んでください（複数可）。",
  "",
  "❯ 1. [ ] パーサを実物に合わせて直す",
  "  撮れた実画面をフィクスチャとしてテストに固定し、複数選択の解析を現行の描画に合わせて修正します。根本原因が実物で確認できた場合のみ意味があります。",
  "  2. [ ] PR #10をマージしてデプロイ",
  "  「読めない質問には答えない」「画面をログに残す」「snippetを罫線で止める」の3件を本番に反映します。Spokeの再起動を伴います。",
  "  3. [ ] CIをpush（workflowスコープ）",
  "  gh auth refresh -s workflow を実行いただければ、検証済みのCIコミットをpushしてPRを立てます。",
  "  4. [ ] 飯田さんに共有",
  "  複数選択の描画が未検証だった件と今回の原因を、PR #10のコメントかIssueとして共同開発者に共有します。",
  "  5. [ ] Type something",
  "     Submit",
  "─".repeat(213),
  "  6. Chat about this",
].join("\n");

test("a real multi-select dialog is read as a question, not as an unparseable menu", () => {
  // Production incident: this exact shape anchored on nothing, so the question
  // parser returned null, the driver fell through to the permission branch,
  // that could not read it either, and Slack got "menu could not be parsed" —
  // then a bare `y` was sent into the checkbox list. Single-select was
  // unaffected, which is why question 1 of the same dialog worked and
  // question 2 did not.
  const prompt = claudeDriver.parseBlockedPane(LIVE_MULTI_SELECT);
  assert.equal(prompt.kind, "question", "a checkbox on the free-text row must not hide the dialog");
  if (prompt.kind === "question") assert.equal(prompt.verified.form, "compound");
});

test("the captured dialog's options, question and multiSelect flag all come through", () => {
  const info = parseAskUserQuestionPane(LIVE_MULTI_SELECT);
  assert.ok(info);
  assert.equal(info.multiSelect, true);
  assert.deepEqual(
    info.options.map((o) => o.label),
    ["パーサを実物に合わせて直す", "PR #10をマージしてデプロイ", "CIをpush（workflowスコープ）", "飯田さんに共有"],
    "the free-text and Chat rows are not options",
  );
  assert.ok(info.options.every((o) => (o.description ?? "").length > 0), "each option keeps its description");
});

test("the gutter bar the TUI draws beside a question is not part of the question", () => {
  // `│ 複数選択の描画を…` — chrome, but on the same line as the text, so trimming
  // alone left it in the Slack message.
  const info = parseAskUserQuestionPane(LIVE_MULTI_SELECT);
  assert.ok(info?.question.startsWith("複数選択の描画を"), `question was: ${info?.question}`);
  assert.ok(!info?.question.includes("│"));
});

test("a single-select free-text row still anchors, checkbox or not", () => {
  // The optional checkbox must not make the period-less form mandatory: the
  // classic single-select rendering has neither checkbox nor bar.
  const classic = ["☐ 実装方針", "", "どの方式で？", "", "❯ 1. A方式", "  2. B方式", "  3. Type something."].join("\n");
  assert.equal(parseAskUserQuestionPane(classic)?.options.length, 2);
});

// --- multi-select submission, captured from a live pane ---------------------
//
// Every assertion below is the keystroke sequence measured against a real
// multi-select dialog on Claude Code 2.1.251, in the order it was measured:
//
//   1. `2` toggles option 2 to [✔]; the cursor stays on row 1, nothing submits.
//   2. `4` toggles option 4 as well — selections accumulate.
//   3. Down × (options.length + 1) puts the cursor on the `Submit` row, which
//      sits one past the `Type something` row.
//   4. Enter there opens a review screen; `1` on it is what actually submits.
//      The transcript then recorded exactly `"Bravo, Delta"`.
//
// Written from a capture rather than from the single-select path on purpose:
// the previous multi-select bug came from a fixture written by assumption.

const MULTI_INFO = {
  header: "テスト",
  question: "テスト用の質問です",
  options: [{ label: "Alpha" }, { label: "Bravo" }, { label: "Charlie" }, { label: "Delta" }],
  multiSelect: true,
};

const MULTI_PROMPT = [
  "☒ テスト",
  "",
  "テスト用の質問です",
  "",
  "❯ 1. [ ] Alpha",
  "  2. [ ] Bravo",
  "  3. [ ] Charlie",
  "  4. [ ] Delta",
  "  5. Type something.",
].join("\n");

const REVIEW_SCREEN = [
  "←  ☒ テスト  ✔ Submit  →",
  "",
  "Review your answers",
  "",
  " ● テスト用の質問です",
  "   → Bravo, Delta",
  "",
  "Ready to submit your answers?",
  "",
  "❯ 1. Submit answers",
].join("\n");

test("a multi-select answer confirms a review without requiring a Cancel row", async () => {
  const { herdr, channel, sent } = fakeHerdr(() => REVIEW_SCREEN, undefined, MULTI_PROMPT);
  await claudeDriver.answerQuestionMultiSelect!(herdr, channel, TEST_REF, [2, 4], MULTI_INFO);
  assert.deepEqual(sent, [
    "text:2",
    "text:4",
    // options.length + 1 — the free-text row, then Submit.
    "key:Down",
    "key:Down",
    "key:Down",
    "key:Down",
    "key:Down",
    "key:Enter",
    "text:1",
  ]);
});

test("the confirming digit is withheld when the review screen is not the thing on screen", async () => {
  // Only the dialog's *last* question opens a review screen. For an earlier one
  // the next question comes up instead, where `1` would toggle its first option
  // — an answer to a question nobody was asked.
  const nextQuestion = ["☐ 次の質問", "", "別の質問です", "", "❯ 1. [ ] X", "  2. [ ] Y", "  3. [ ] Type something"].join(
    "\n",
  );
  const { herdr, channel, sent } = fakeHerdr(() => nextQuestion, undefined, MULTI_PROMPT);
  await claudeDriver.answerQuestionMultiSelect!(herdr, channel, TEST_REF, [1], MULTI_INFO);
  assert.equal(sent.at(-1), "key:Enter", "stops at the Submit row's Enter");
  assert.ok(!sent.slice(sent.indexOf("key:Enter")).includes("text:1"));
});

test("a cancelled pane gets no keystrokes past the point it was cancelled", async () => {
  // Same reasoning as answerQuestionOption's cancellation test: this runs
  // outside the poll loop, so the pane may already belong to something else.
  const controller = new AbortController();
  controller.abort();
  const { herdr, channel, sent } = fakeHerdr(() => REVIEW_SCREEN, undefined, MULTI_PROMPT);
  await assert.rejects(
    claudeDriver.answerQuestionMultiSelect!(herdr, channel, TEST_REF, [2], MULTI_INFO, controller.signal),
    ExpectationLost,
  );
  assert.deepEqual(sent, [], "an already-cancelled answer must not be reported as completed");
});

test("free text on a multi-select dialog is submitted, not un-ticked", async () => {
  // Reported from production: replying "1,3" left the dialog sitting there.
  // Measured on a live 2.1.251 pane — typing into the free-text row ticks it
  // automatically, and the Enter the single-select path sends means "select"
  // here, so it unticks the answer and submits nothing.
  const { herdr, channel, sent } = fakeHerdr(() => REVIEW_SCREEN, undefined, MULTI_PROMPT);
  await claudeDriver.answerQuestionFreeText!(herdr, channel, TEST_REF, MULTI_INFO, "どれでもない");
  assert.deepEqual(sent, [
    // options.length downs onto the free-text row, then the text ...
    "key:Down",
    "key:Down",
    "key:Down",
    "key:Down",
    "text:どれでもない",
    // ... then one more Down onto Submit, Enter, and the review confirmation.
    "key:Down",
    "key:Enter",
    "text:1",
  ]);
});

test("free text on a single-select dialog still submits with the one Enter", async () => {
  const { herdr, channel, sent } = fakeHerdr(() => PREVIEW_PANE);
  await claudeDriver.answerQuestionFreeText!(herdr, channel, TEST_REF, PREVIEW_INFO, "別の案がある");
  assert.deepEqual(sent, ["key:Down", "key:Down", "text:別の案がある", "key:Enter"]);
});

interface ScreenTerminal {
  tail?: unknown;
  draft?: unknown;
  source?: unknown;
  status?: unknown;
  truncated?: unknown;
  limited?: unknown;
}

interface ScreenCapture {
  terminal?: ScreenTerminal;
  result?: { terminal?: ScreenTerminal };
}

// Historical Claude prompt fixtures retain only `result.terminal`; tests using them are synthetic
// at the CLI boundary because their full raw Orca envelopes were not retained.
function capturedScreen(filename: string): ScreenSnapshot {
  const capture = JSON.parse(
    readFileSync(new URL(`./__fixtures__/${filename}`, import.meta.url), "utf8"),
  ) as ScreenCapture;
  const terminal = capture.result?.terminal ?? capture.terminal ?? {};
  const rawTail = terminal.tail;
  const tail = Array.isArray(rawTail) ? rawTail : [];
  const lines = tail.filter((line): line is string => typeof line === "string");
  return {
    text: lines.join("\n"),
    draft: typeof terminal.draft === "string" ? terminal.draft : null,
    complete:
      Array.isArray(rawTail) &&
      lines.length === tail.length &&
      terminal.source === "screen" &&
      terminal.status === "running" &&
      terminal.truncated === false &&
      terminal.limited === false,
  };
}

function capturedOrcaProbeScreen(filename: string): ScreenSnapshot {
  const capture = JSON.parse(
    readFileSync(new URL(`../../backend/__fixtures__/orca/${filename}`, import.meta.url), "utf8"),
  ) as ScreenCapture;
  const terminal = capture.result?.terminal ?? capture.terminal ?? {};
  const rawTail = terminal.tail;
  const tail = Array.isArray(rawTail) ? rawTail : [];
  const lines = tail.filter((line): line is string => typeof line === "string");
  return {
    text: lines.join("\n"),
    draft: typeof terminal.draft === "string" ? terminal.draft : null,
    complete:
      Array.isArray(rawTail) &&
      lines.length === tail.length &&
      terminal.source === "screen" &&
      terminal.status === "running" &&
      terminal.truncated === false &&
      terminal.limited === false,
  };
}

test("fresh probe's Try placeholder is idle only with an empty draft", () => {
  const screen = capturedOrcaProbeScreen("probe-A-fresh.json");
  assert.equal(screen.draft, null);
  assert.equal(isIdleComposer(screen), true);
  assert.equal(isIdleComposer({ ...screen, draft: "retained draft" }), false);
  assert.equal(isIdleComposer({ ...screen, draft: "" }), false);
});

test("typed idle composer and restored Ctrl+S prompt remain eligible for probing", () => {
  const typed = capturedOrcaProbeScreen("probe-C-typed.json");
  assert.equal(typed.draft, "typed draft probe");
  assert.equal(isIdleComposer(typed), true);
  assert.equal(isIdleComposer(capturedOrcaProbeScreen("p3-10-stashed.json")), true);
});

function isIdleComposer(snapshot: ScreenSnapshot): boolean {
  return claudeDriver.isIdleComposer?.(snapshot) === true;
}

test("Claude recognizes a complete captured empty composer", () => {
  assert.equal(isIdleComposer(capturedScreen("idle-composer.screen.json")), true);
});

test("Claude recognizes the empty composer of a session named with /rename", () => {
  const named = capturedScreen("idle-composer-named-session.screen.json");
  assert.match(named.text, /^─+ design ─$/mu, "the captured rule must carry the session name");
  assert.equal(isIdleComposer(named), true);
});

test("Claude still requires a plain rule below the prompt", () => {
  const named = capturedScreen("idle-composer-named-session.screen.json");
  const rows = named.text.split("\n");
  const prompt = rows.indexOf("❯");
  rows[prompt + 1] = rows[prompt - 1]!;
  assert.equal(isIdleComposer({ ...named, text: rows.join("\n") }), false);
});

test("Claude rejects the active ✳ status row by shape, independent of its verb", () => {
  const working = capturedScreen("working.screen.json");
  assert.equal(isIdleComposer(working), false);

  const alternateVerb = working.text.replace(/^(\s*✳\s+)\S+/mu, "$1Waddling…");
  assert.notEqual(alternateVerb, working.text, "the captured active status row must be present");
  assert.equal(isIdleComposer({ ...working, text: alternateVerb }), false);
});

test("Claude rejects open question and model menus", () => {
  for (const filename of [
    "ask-user-question-before-down.screen.json",
    "ask-user-question-after-down.screen.json",
    "model-menu-before-down.screen.json",
    "model-menu-after-down.screen.json",
  ]) {
    assert.equal(isIdleComposer(capturedScreen(filename)), false, filename);
  }
});

test("Claude recognizes cancelled question and model menus after they return to the idle composer", () => {
  for (const filename of [
    "ask-user-question-cancelled.screen.json",
    "model-menu-cancelled.screen.json",
  ]) {
    assert.equal(isIdleComposer(capturedScreen(filename)), true, filename);
  }
});

test("Claude requires a complete screen and an empty composer row", () => {
  const idle = capturedScreen("idle-composer.screen.json");
  assert.equal(isIdleComposer({ ...idle, complete: false }), false);

  const typedComposer = idle.text.replace("\n❯\n", "\n❯ keep this draft\n");
  assert.notEqual(typedComposer, idle.text, "the fixture must contain an empty composer row");
  assert.equal(isIdleComposer({ ...idle, text: typedComposer, draft: null }), false);
});

test("a redacted shell prompt is not a Claude composer", () => {
  const shell = capturedScreen("shell-prompt.screen.json");
  assert.equal(shell.complete, false, "the source capture is truncated");
  assert.equal(isIdleComposer(shell), false);
  // The parser must reject shell text even when a caller marks the truncated frame complete.
  assert.equal(isIdleComposer({ ...shell, complete: true }), false);
});

test("Claude reads a question with a mod's side pane open beside it once the pane is stripped", () => {
  const screen = capturedScreen("side-pane-question.screen.json");
  assert.match(screen.text, /Type something\.\s+│おすすめ$/mu, "the capture must carry the pane on the dialog's rows");

  const prompt = claudeDriver.parseBlockedPane(stripSidePane(screen.text));
  assert.equal(prompt.kind, "question");
  if (prompt.kind !== "question") return;
  assert.equal(prompt.info.header, "テスト方針");
  assert.equal(
    prompt.info.question,
    "Hub の heartbeat 検知（Spoke が無反応になったらスレッドに通知する機能）のテストは、どの方針で書きますか？",
  );
  assert.deepEqual(
    prompt.info.options.map((o) => o.label),
    ["偽タイマーで単体テスト (Recommended)", "実 Hub と Spoke の統合テスト", "両方（単体＋少数の統合）"],
  );
  assert.equal(prompt.info.multiSelect, false);
});

test("Claude sees the empty composer below a mod's side pane that stayed open after the answer", () => {
  const screen = capturedScreen("side-pane-after-answer.screen.json");
  const stripped = stripSidePane(screen.text);
  assert.doesNotMatch(stripped, /回答済み|偽タイマーで単体テスト \(Recommended\)\s+│/u);
  assert.match(stripped, /Update available!/u, "full-width rows below the pane must survive");
  assert.equal(isIdleComposer({ ...screen, text: stripped }), true);
});

const TYPED_ANSWER = "審査員に触ってもらう前提で進めたい．\nアカウントを分けるか，権限を絞った管理者 role にするのがよいと思う．";
const THREE_OPTIONS = { header: "", question: "", options: [{ label: "a" }, { label: "b" }, { label: "c" }], multiSelect: false };
const freeTextScreen = (state: "before" | "cursor-on-row" | "typed") =>
  stripSidePane(capturedScreen(`free-text-${state}.screen.json`).text);

test("Claude reads a question that wraps onto two rows whole, not just its last row", () => {
  const prompt = claudeDriver.parseBlockedPane(freeTextScreen("before"));
  assert.equal(prompt.kind, "question");
  if (prompt.kind !== "question") return;
  assert.equal(
    prompt.info.question,
    "Hub が無反応の Spoke に気づいたときにスレッドへ知らせる機能について、境界の条件と通知の文面の両方を確かめたいのですが、テストはどの方針で書きますか？",
  );
});

test("Claude still knows the question once an answer is typed into its free-text row", () => {
  const fingerprints = (["before", "cursor-on-row", "typed"] as const).map((state) => {
    const prompt = claudeDriver.parseBlockedPane(freeTextScreen(state));
    assert.equal(prompt.kind, "question", state);
    return prompt.kind === "question" ? prompt.verified.fingerprint : null;
  });
  assert.equal(new Set(fingerprints).size, 1, "typing must not make it a different prompt");

  const typed = freeTextScreen("typed");
  assert.equal(parseCursorLabel(typed), TYPED_ANSWER, "the cursor label carries every line that was typed");
  assert.deepEqual(classicDialogState(typed), { freeTextNum: 4, freeTextEdited: true, cursorNum: 4 });
  assert.deepEqual(classicDialogState(freeTextScreen("cursor-on-row")), {
    freeTextNum: 4,
    freeTextEdited: false,
    cursorNum: 4,
  });
  assert.deepEqual(classicDialogState(freeTextScreen("before")), { freeTextNum: 4, freeTextEdited: false, cursorNum: 1 });
});

test("free text moves from where the cursor is, not from option 1", async () => {
  const fromTop = fakeHerdr(() => freeTextScreen("before"), undefined, freeTextScreen("before"));
  await claudeDriver.answerQuestionFreeText!(fromTop.herdr, fromTop.channel, TEST_REF, THREE_OPTIONS, "x");
  assert.deepEqual(fromTop.sent, ["key:Down", "key:Down", "key:Down", "text:x", "key:Enter"]);

  // Three Downs from here overshoot onto "Chat about this" (measured on a live pane).
  const onRow = fakeHerdr(() => freeTextScreen("cursor-on-row"), undefined, freeTextScreen("before"));
  await claudeDriver.answerQuestionFreeText!(onRow.herdr, onRow.channel, TEST_REF, THREE_OPTIONS, "x");
  assert.deepEqual(onRow.sent, ["text:x", "key:Enter"]);
});

test("no key is sent into a free-text row that already holds text, or as a digit while the cursor is on it", async () => {
  const typed = fakeHerdr(() => freeTextScreen("typed"), undefined, freeTextScreen("before"));
  await assert.rejects(
    claudeDriver.answerQuestionFreeText!(typed.herdr, typed.channel, TEST_REF, THREE_OPTIONS, "x"),
    (error: unknown) => error instanceof ExpectationLost && /入力途中の文/u.test(error.userMessage ?? ""),
  );
  assert.deepEqual(typed.sent, []);

  // From the free-text row a digit is typed into the text instead of choosing (measured).
  const onRow = fakeHerdr(() => freeTextScreen("cursor-on-row"), undefined, freeTextScreen("before"));
  await assert.rejects(
    claudeDriver.answerQuestionOption!(onRow.herdr, onRow.channel, "w0:p1", 1, THREE_OPTIONS),
    (error: unknown) => error instanceof ExpectationLost && /自由記述の欄/u.test(error.userMessage ?? ""),
  );
  assert.deepEqual(onRow.sent, []);
});
