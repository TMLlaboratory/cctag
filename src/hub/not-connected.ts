/**
 * What to tell a thread when an event's owner has no Spoke connected.
 *
 * Two different situations used to share one message. Someone who has never
 * been issued a token was told to check that their Spoke daemon was running —
 * a daemon they had never set up — so the first thing a new user saw pointed
 * them at the wrong problem. Whether a token was ever issued is the Hub's to
 * know, so it says which one it is.
 *
 * Its own module so it can be tested: hub/index.ts runs `main()` at import.
 */
export function notConnectedText(registered: boolean): string {
  if (registered) {
    return "⚠️ 起動していません。cctagを動かしている計算機のspokeデーモンが起動しているか確認してください。";
  }
  return (
    "⚠️ まだ cctag の利用登録がありません。使うには、Hub の管理者に Spoke 用のトークンを発行してもらい、" +
    "自分の計算機で Spoke を動かしてください。手順: " +
    "<https://github.com/TMLlaboratory/cctag/blob/main/docs/spoke-setup.md|Spoke のセットアップ>"
  );
}
