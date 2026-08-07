import { markdownTableBlock, markdownTableFallback } from "./blocks.js";
import { segmentForSlack, type SlackSegment } from "./mrkdwn.js";
import type { Notifier } from "../notifier.js";

/** Slack's documented ceiling on blocks in one message. */
const MAX_BLOCKS = 50;

function blocksFor(segment: SlackSegment): unknown[] {
  if (segment.kind === "text") return [{ type: "section", text: { type: "mrkdwn", text: segment.text } }];
  const table = markdownTableBlock(segment.table);
  if (table) return [table];
  // Too big for a table block — post it as a monospace grid rather than drop it.
  return [{ type: "section", text: { type: "mrkdwn", text: markdownTableFallback(segment.table) } }];
}

/**
 * Posts a turn's Markdown, rendering its tables as Block Kit tables and keeping
 * prose and tables in their original order.
 *
 * `postMessage` rather than `postReply` because only the former carries
 * `blocks` — and it carries them all the way through Hub–Spoke, where
 * `post_reply`'s RPC payload is text-only. The returned handle is discarded;
 * this is a normal thread post that never gets edited.
 *
 * Interleaving in one message is safe: neither "one table per message" nor
 * "a table must be the last block" turned out to exist (verified by posting
 * [section, table, section, table] successfully). Splitting only happens at
 * Slack's real ceilings — MAX_BLOCKS here, and the character caps that
 * chunkForSlack and markdownTableBlock already apply.
 */
export async function postSegmented(
  notifier: Notifier,
  channel: string,
  threadTs: string,
  markdown: string,
  /** Prepended to the very first block, for the watcher's "detected at the
   *  terminal" banner. */
  prefix?: string,
): Promise<void> {
  const segments = segmentForSlack(markdown);
  if (segments.length === 0) return;

  const blocks = segments.flatMap(blocksFor);
  if (prefix) blocks.unshift({ type: "section", text: { type: "mrkdwn", text: prefix } });

  for (let i = 0; i < blocks.length; i += MAX_BLOCKS) {
    const batch = blocks.slice(i, i + MAX_BLOCKS);
    // `text` is the notification/fallback string, not the body — Slack shows it
    // in push notifications and to clients that can't render blocks.
    const fallback = segments.find((s) => s.kind === "text")?.text ?? "（表）";
    await notifier.postMessage(channel, threadTs, fallback.slice(0, 300), batch);
  }
}
