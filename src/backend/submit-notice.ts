import type { BackendName } from "./types.js";
import {
  EMPTY_SUBMIT_COMPOSER_STATE,
  SubmitRefused,
  UNSENDABLE_TEXT_MESSAGE,
  WRITE_OUTCOME_UNKNOWN_MESSAGE,
  type SubmitComposerState,
  WriteOutcomeUnknown,
} from "./types.js";

export function submitRefusedText(
  reason: SubmitRefused["reason"],
  backend: BackendName,
  composer: SubmitComposerState = EMPTY_SUBMIT_COMPOSER_STATE,
): string {
  let message: string;
  switch (reason) {
    case "not-idle":
      message = `⚠️ ${backend} は入力待ちではないため送信しませんでした。ターミナルの状態を確認してください。`;
      break;
    case "draft":
      message = `⚠️ ${backend} の入力欄に未送信の文字があります。送信していません。ターミナルで確認してください。`;
      break;
    case "probe-unverified":
      message = `⚠️ ${backend} の入力欄が提案か書きかけかを確かめられなかったため、送信していません。`;
      break;
    case "stash-unverified":
      message = `⚠️ ${backend} の入力欄の書きかけを Ctrl+S で退避しようとしましたが、送れる状態か確かめられなかったため、送信していません。`;
      break;
    case "gate":
      message = `⚠️ ${backend} のダイアログが送信を拒否しました。このダイアログは端末で答えてください。`;
      break;
    case "incomplete-screen":
      message = `⚠️ ${backend} の画面を完全に確認できなかったため、送信しませんでした。`;
      break;
    case "agent-changed":
      message = `⚠️ ${backend} の接続先エージェントが切り替わったため、送信しませんでした。再度送信してください。`;
      break;
    case "cancelled":
      message = `⚠️ ${backend} への送信を中止しました。`;
      break;
    case "unsafe-text":
      message = UNSENDABLE_TEXT_MESSAGE;
      break;
  }
  return withComposerState(message, composer);
}

export function writeOutcomeUnknownText(error: WriteOutcomeUnknown): string {
  return withComposerState(WRITE_OUTCOME_UNKNOWN_MESSAGE, error.composer);
}

export function draftStashedText(backend: BackendName): string {
  return `📥 ${backend} の入力欄の書きかけを一時退避して送りました。Claude Code 2.1.287 では送信の後に入力欄へ戻ります。戻っていなければ、入力欄が空（打った文字も灰色の提案も無い）のときに Ctrl+S を押すと戻ります。`;
}

function withComposerState(message: string, composer: SubmitComposerState): string {
  const notes: string[] = [];
  if (composer.probe !== null) {
    notes.push(`確かめのために打った \`${composer.probe}\` が入力欄に1文字残っているかもしれません。`);
  }

  if (composer.stash === "uncertain") {
    notes.push(
      "書きかけが Ctrl+S で退避されたかどうかを確かめられませんでした。端末で入力欄を見てください。入力欄に文字があるときに Ctrl+S を押すと、その文字が退避され、前に退避したものは消えます。",
    );
  } else if (composer.stash === "stashed" && composer.submitUncertain) {
    notes.push(
      "送信の前に、入力欄の書きかけを Ctrl+S で退避しました。送信されていれば、Claude Code が入力欄に戻していることがあります（2.1.287）。まず端末で入力欄を見て、書きかけが戻っておらず入力欄が空（打った文字も灰色の提案も無い）のときだけ Ctrl+S を押してください。",
    );
  } else if (composer.stash === "stashed") {
    notes.push(
      "送信の前に、入力欄の書きかけを Ctrl+S で退避しました。入力欄が空（打った文字も灰色の提案も無い）のときに Ctrl+S を押すと戻ります。文字があるときに押すと、退避した書きかけは消えます。",
    );
  }

  const completeMessage = notes.length === 0 ? message : `${message} ${notes.join(" ")}`;
  return /(?:端末|ターミナル)/u.test(completeMessage)
    ? completeMessage
    : `${completeMessage} 端末で確かめてください。`;
}
