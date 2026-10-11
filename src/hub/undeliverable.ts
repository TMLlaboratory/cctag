import { RpcFailure } from "../ws/rpc.js";

/**
 * What to tell a thread when dispatching one of its events to the Spoke failed,
 * or null to tell it nothing.
 *
 * Its own module so it can be tested: hub/index.ts runs `main()` at import.
 */
export function undeliverableNotice(err: unknown): string | null {
  if (!(err instanceof RpcFailure)) return null;
  switch (err.kind) {
    case "closed":
      return "⚠️ cctagを動かしている本人の spoke に届きませんでした。接続が切れている可能性があります。少し待ってからもう一度お試しください。";
    case "timeout":
      // Not "did not arrive": a mention with a large attachment is still being
      // downloaded when the call times out, and sending it again is refused as busy.
      return "⚠️ cctagを動かしている本人の spoke から応答がありません。処理に時間がかかっているだけの場合もあります。しばらく待ってもスレッドに反応がなければ、もう一度お試しください。";
    case "remote":
      // Not reported: the Spoke received this and is alive, so neither wording fits.
      return null;
  }
}
