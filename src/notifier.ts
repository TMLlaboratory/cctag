/**
 * Everything turn.ts needs to talk back to "the chat platform", kept free of
 * any Slack SDK types so the core engine (herdr / transcript / turn) stays
 * portable. Phase 1 implements this with @slack/bolt directly; Phase 4
 * (Hub–Spoke) implements it by forwarding over a WebSocket to the Hub.
 *
 * `blocks` is a plain JSON value (Slack Block Kit's block array) — treated as
 * opaque data here, not typed against the Slack SDK, so it forwards cleanly
 * over a WebSocket in the Hub–Spoke design too.
 */
import type { IncomingFile } from "./attachments.js";

export interface MessageHandle {
  update(text: string, blocks?: unknown[]): Promise<void>;
}

export interface Notifier {
  /** Posts a new message in the thread (used for the aggregated turn result). */
  postReply(channel: string, threadTs: string, text: string): Promise<void>;
  /** Posts a message that will be updated in place (status line, or a prompt with buttons). */
  postMessage(channel: string, threadTs: string, text: string, blocks?: unknown[]): Promise<MessageHandle>;
  /** Best-effort permalink lookup, used for the "already paired elsewhere" hint. */
  getPermalink?(channel: string, ts: string): Promise<string | null>;
  /**
   * Thread messages posted after cctag's own last message in this thread
   * (or the whole thread, if cctag hasn't posted yet), formatted as one
   * "speaker: text" line per message. `excludeTs` is the triggering
   * command's own message ts, dropped from the result. Used by the `log`
   * command to catch cctag up on conversation it wasn't mentioned in.
   */
  getThreadHistorySinceLastBotPost?(channel: string, threadTs: string, excludeTs: string): Promise<string[]>;
  /**
   * Uploads a file to the thread. `content` is the file's text (plans are
   * markdown), `filename` its display name, `title`/`comment` optional. Used
   * to attach a plan-mode plan file. In Hub–Spoke mode the content travels
   * over the WebSocket to the Hub, which holds the real Slack client.
   */
  uploadTextFile?(
    channel: string,
    threadTs: string,
    args: { content: string; filename: string; title?: string; comment?: string },
  ): Promise<void>;
  /**
   * Uploads arbitrary bytes (images, PDFs, ...) to the thread, base64-encoded
   * so the payload survives the Hub–Spoke JSON RPC unchanged. Separate from
   * uploadTextFile rather than replacing it because Hub and Spoke ship
   * independently: a Spoke talking to a Hub that predates this method gets a
   * "no handler" error, which is why callers must tolerate it throwing.
   */
  uploadFile?(
    channel: string,
    threadTs: string,
    args: { contentB64: string; filename: string; title?: string; comment?: string },
  ): Promise<void>;
  /**
   * Downloads a file a user attached in Slack, as base64. Absent when the
   * platform adapter can't reach Slack's file API. The Spoke never sees the
   * bot token, so its implementation asks the Hub to do the download.
   */
  fetchIncomingFile?(file: IncomingFile): Promise<string | null>;
}

/**
 * Whether a failed Notifier call failed because the remote end doesn't
 * implement the method at all, as opposed to failing on its merits.
 *
 * Only Hub–Spoke mode can produce this: the Hub and the Spoke ship
 * independently, so a Spoke can be newer than the Hub it connects to and call
 * an RPC method that Hub build has never heard of (WsRpc answers "no handler
 * for ..."). Worth distinguishing because the fix is "update the Hub", not
 * "retry" — and the method-presence checks callers do (`notifier.uploadFile?`)
 * can't see it, since the Spoke's proxy implements every method locally.
 */
export function isUnsupportedByRemote(err: unknown): boolean {
  return err instanceof Error && /no handler for/.test(err.message);
}
