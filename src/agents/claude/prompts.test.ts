import { test } from "node:test";
import assert from "node:assert/strict";
import {
  looksLikeQuestionScreen,
  parseAskUserQuestionPane,
  parsePreviewQuestionPane,
  previewAnchorIndex,
} from "./prompts.js";
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

test("a following question that repeats the wording does not inherit the Enter", async () => {
  // Codex re-review round 3, Critical 2. Comparing the question text alone meant a
  // next question phrased identically looked like the one just answered, and took
  // an Enter that confirmed *its* default option.
  const sameWordingDifferentOptions = PREVIEW_PANE.replace(
    "  2. 明るいティール＆コーラル     │ サブアクセント: #8C7A5B (くすみゴールド)                    │",
    "  2. 全く別の選択肢               │ サブアクセント: #8C7A5B (くすみゴールド)                    │",
  );
  const { herdr, sent } = fakeHerdr(() => sameWordingDifferentOptions);
  await claudeDriver.answerQuestionOption!(herdr, "w0:p1", 1, PREVIEW_INFO);
  assert.deepEqual(sent, ["text:1"], "different options mean a different question");
});

test("a cancelled pane gets the digit but never the confirming Enter", async () => {
  // Codex re-review round 3, Critical 3. This runs outside the poll loop, which
  // releases the pane as soon as it is asked to stop — so by the time the Enter
  // would be sent, something else may hold the pane.
  const { herdr, sent } = fakeHerdr(() => PREVIEW_PANE);
  const controller = new AbortController();
  controller.abort();
  await claudeDriver.answerQuestionOption!(herdr, "w0:p1", 2, PREVIEW_INFO, controller.signal);
  assert.deepEqual(sent, ["text:2"], "no keystroke may follow the release");
});

test("a failed re-read is reported, not treated as answered", async () => {
  // Codex re-review round 3, Critical 4. Swallowing it meant no Enter was sent
  // while the caller marked the Slack prompt answered — the pane stayed waiting
  // and the same prompt came back on the next poll.
  const herdr = {
    async agentSend() {},
    async paneSendKeys() {},
    async paneRead() {
      throw new Error("herdr command timed out");
    },
  } as unknown as Parameters<NonNullable<typeof claudeDriver.answerQuestionOption>>[0];
  await assert.rejects(
    claudeDriver.answerQuestionOption!(herdr, "w0:p1", 1, PREVIEW_INFO),
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
  assert.deepEqual(prompt.info.options.map((o) => o.label), PREVIEW_LABELS);
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
  "  2. Cancel",
].join("\n");

test("a multi-select answer toggles each choice, walks to Submit, then confirms the review", async () => {
  const { herdr, sent } = fakeHerdr(() => REVIEW_SCREEN);
  await claudeDriver.answerQuestionMultiSelect!(herdr, "w0:p1", [2, 4], MULTI_INFO);
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
  const { herdr, sent } = fakeHerdr(() => nextQuestion);
  await claudeDriver.answerQuestionMultiSelect!(herdr, "w0:p1", [1], MULTI_INFO);
  assert.equal(sent.at(-1), "key:Enter", "stops at the Submit row's Enter");
  assert.ok(!sent.slice(sent.indexOf("key:Enter")).includes("text:1"));
});

test("a cancelled pane gets no keystrokes past the point it was cancelled", async () => {
  // Same reasoning as answerQuestionOption's cancellation test: this runs
  // outside the poll loop, so the pane may already belong to something else.
  const controller = new AbortController();
  controller.abort();
  const { herdr, sent } = fakeHerdr(() => REVIEW_SCREEN);
  await claudeDriver.answerQuestionMultiSelect!(herdr, "w0:p1", [2], MULTI_INFO, controller.signal);
  assert.ok(!sent.includes("key:Enter"), "the submitting Enter must not reach a released pane");
  assert.ok(!sent.includes("text:1"));
});

test("free text on a multi-select dialog is submitted, not un-ticked", async () => {
  // Reported from production: replying "1,3" left the dialog sitting there.
  // Measured on a live 2.1.251 pane — typing into the free-text row ticks it
  // automatically, and the Enter the single-select path sends means "select"
  // here, so it unticks the answer and submits nothing.
  const { herdr, sent } = fakeHerdr(() => REVIEW_SCREEN);
  await claudeDriver.answerQuestionFreeText!(herdr, "w0:p1", MULTI_INFO, "どれでもない");
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
  const { herdr, sent } = fakeHerdr(() => PREVIEW_PANE);
  await claudeDriver.answerQuestionFreeText!(herdr, "w0:p1", PREVIEW_INFO, "別の案がある");
  assert.deepEqual(sent, ["key:Down", "key:Down", "text:別の案がある", "key:Enter"]);
});
