import { test } from "node:test";
import assert from "node:assert/strict";
import { submitRefusedText, writeOutcomeUnknownText } from "./submit-notice.js";
import { UNSENDABLE_TEXT_MESSAGE, WRITE_OUTCOME_UNKNOWN_MESSAGE, WriteOutcomeUnknown } from "./types.js";

test("every submit refusal reason has Slack text that points at the terminal", () => {
  const cases = [
    ["not-idle", "⚠️ orca は入力待ちではないため送信しませんでした。ターミナルの状態を確認してください。"],
    ["draft", "⚠️ orca の入力欄に未送信の文字があります。送信していません。ターミナルで確認してください。"],
    ["probe-unverified", "⚠️ orca の入力欄が提案か書きかけかを確かめられなかったため、送信していません。 端末で確かめてください。"],
    ["stash-unverified", "⚠️ orca の入力欄の書きかけを Ctrl+S で退避しようとしましたが、送れる状態か確かめられなかったため、送信していません。 端末で確かめてください。"],
    ["gate", "⚠️ orca のダイアログが送信を拒否しました。このダイアログは端末で答えてください。"],
    ["incomplete-screen", "⚠️ orca の画面を完全に確認できなかったため、送信しませんでした。 端末で確かめてください。"],
    ["agent-changed", "⚠️ orca の接続先エージェントが切り替わったため、送信しませんでした。再度送信してください。 端末で確かめてください。"],
    ["cancelled", "⚠️ orca への送信を中止しました。 端末で確かめてください。"],
    ["unsafe-text", `${UNSENDABLE_TEXT_MESSAGE} 端末で確かめてください。`],
  ] as const;
  for (const [reason, expected] of cases) {
    assert.equal(submitRefusedText(reason, "orca"), expected, reason);
  }
  assert.equal(
    submitRefusedText("not-idle", "herdr"),
    "⚠️ herdr は入力待ちではないため送信しませんでした。ターミナルの状態を確認してください。",
  );
});

test("composer side effects are appended to the refusal and unknown-outcome text", () => {
  assert.equal(
    submitRefusedText("gate", "orca", { probe: null, stash: "stashed", submitUncertain: false }),
    "⚠️ orca のダイアログが送信を拒否しました。このダイアログは端末で答えてください。 送信の前に、入力欄の書きかけを Ctrl+S で退避しました。入力欄が空（打った文字も灰色の提案も無い）のときに Ctrl+S を押すと戻ります。文字があるときに押すと、退避した書きかけは消えます。",
  );
  assert.equal(writeOutcomeUnknownText(new WriteOutcomeUnknown()), WRITE_OUTCOME_UNKNOWN_MESSAGE);
  assert.equal(
    writeOutcomeUnknownText(new WriteOutcomeUnknown(undefined, { probe: "y", stash: "uncertain", submitUncertain: false })),
    "送信できたか確認できません。端末を確かめてください 確かめのために打った `y` が入力欄に1文字残っているかもしれません。 書きかけが Ctrl+S で退避されたかどうかを確かめられませんでした。端末で入力欄を見てください。入力欄に文字があるときに Ctrl+S を押すと、その文字が退避され、前に退避したものは消えます。",
  );
});
