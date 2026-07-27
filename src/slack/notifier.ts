import type { WebClient } from "@slack/web-api";
import type { IncomingFile } from "../attachments.js";
import type { MessageHandle, Notifier } from "../notifier.js";
import { stripComposerAttribution } from "../commands.js";

export class SlackNotifier implements Notifier {
  private botUserId: string | undefined;

  constructor(
    private readonly client: WebClient,
    private readonly token: string,
  ) {}

  private async getBotUserId(): Promise<string | undefined> {
    if (this.botUserId === undefined) {
      const res = await this.client.auth.test().catch(() => null);
      this.botUserId = (res?.user_id as string | undefined) ?? undefined;
    }
    return this.botUserId;
  }

  async postReply(channel: string, threadTs: string, text: string): Promise<void> {
    await this.client.chat.postMessage({
      channel,
      thread_ts: threadTs || undefined,
      text,
    });
  }

  async postMessage(channel: string, threadTs: string, text: string, blocks?: unknown[]): Promise<MessageHandle> {
    const res = await this.client.chat.postMessage({
      channel,
      thread_ts: threadTs || undefined,
      text,
      blocks: blocks as never,
    });
    const ts = res.ts as string;
    return {
      update: async (newText: string, newBlocks?: unknown[]) => {
        await this.client.chat.update({ channel, ts, text: newText, blocks: newBlocks as never });
      },
    };
  }

  async getPermalink(channel: string, ts: string): Promise<string | null> {
    const res = await this.client.chat.getPermalink({ channel, message_ts: ts }).catch(() => null);
    return res?.permalink ?? null;
  }

  async getThreadHistorySinceLastBotPost(channel: string, threadTs: string, excludeTs: string): Promise<string[]> {
    return formatThreadHistorySinceLastBotPost(this.client, channel, threadTs, excludeTs, await this.getBotUserId());
  }

  async uploadTextFile(
    channel: string,
    threadTs: string,
    args: { content: string; filename: string; title?: string; comment?: string },
  ): Promise<void> {
    const common = {
      content: args.content,
      filename: args.filename,
      title: args.title,
      initial_comment: args.comment,
    };
    await this.client.files.uploadV2(
      threadTs ? { channel_id: channel, thread_ts: threadTs, ...common } : { channel_id: channel, ...common },
    );
  }

  async uploadFile(
    channel: string,
    threadTs: string,
    args: { contentB64: string; filename: string; title?: string; comment?: string },
  ): Promise<void> {
    await uploadBinaryFile(this.client, channel, threadTs, args);
  }

  async fetchIncomingFile(file: IncomingFile): Promise<string | null> {
    return downloadSlackFile(this.client, this.token, file);
  }
}

/**
 * Shared by the standalone SlackNotifier and the Hub's `upload_file` RPC
 * handler. `file` (a Buffer) rather than `content` (a string) is what makes
 * uploadV2 send the bytes verbatim — passing binary through `content` would
 * corrupt it.
 */
export async function uploadBinaryFile(
  client: WebClient,
  channel: string,
  threadTs: string,
  args: { contentB64: string; filename: string; title?: string; comment?: string },
): Promise<void> {
  const common = {
    file: Buffer.from(args.contentB64, "base64"),
    filename: args.filename,
    title: args.title,
    initial_comment: args.comment,
  };
  await client.files.uploadV2(
    threadTs ? { channel_id: channel, thread_ts: threadTs, ...common } : { channel_id: channel, ...common },
  );
}

/**
 * Downloads a Slack-hosted file. Shared by the standalone notifier and the
 * Hub's `fetch_file` RPC handler — both hold the bot token, which
 * `url_private_download` requires as a bearer header (the URL alone returns
 * an HTML sign-in page, not the bytes, and does so with a 200, hence the
 * content-type check).
 */
export async function downloadSlackFile(
  client: WebClient,
  botToken: string,
  file: IncomingFile,
): Promise<string | null> {
  let url = file.downloadUrl;
  if (!url) {
    // Some events carry only the file id (and Slack's own docs warn the file
    // object can be partial) — resolve the download URL via files.info.
    const info = await client.files.info({ file: file.id }).catch(() => null);
    url = (info?.file as { url_private_download?: string } | undefined)?.url_private_download;
  }
  if (!url) return null;

  const res = await globalThis.fetch(url, { headers: { authorization: `Bearer ${botToken}` } });
  if (!res.ok) {
    console.error(`[slack] file download failed for ${file.name}: HTTP ${res.status}`);
    return null;
  }
  if (res.headers.get("content-type")?.includes("text/html")) {
    console.error(`[slack] file download for ${file.name} returned a sign-in page — check the files:read scope`);
    return null;
  }
  return Buffer.from(await res.arrayBuffer()).toString("base64");
}

interface RepliesMessage {
  ts: string;
  user?: string;
  bot_id?: string;
  username?: string;
  bot_profile?: { name?: string };
  text?: string;
}

/**
 * Shared by both the standalone SlackNotifier and the Hub's RPC handler
 * (hub/index.ts) — both hold a real @slack/bolt WebClient, just wired
 * through different entry points.
 */
export async function formatThreadHistorySinceLastBotPost(
  client: WebClient,
  channel: string,
  threadTs: string,
  excludeTs: string,
  botUserId: string | undefined,
): Promise<string[]> {
  // conversations.replies returns oldest-first and paginates forward toward
  // the newest messages — a single un-paginated call on a thread with more
  // than one page of history would silently omit the most recent messages
  // (and possibly cctag's own last post), which is exactly the tail this
  // function needs. Page up to a generous cap rather than assume one page
  // covers a real lab-usage thread.
  const messages: RepliesMessage[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const res = await client.conversations.replies({ channel, ts: threadTs, limit: 200, cursor }).catch(() => null);
    if (!res) break;
    messages.push(...((res.messages ?? []) as RepliesMessage[]));
    cursor = res.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }

  let lastBotIdx = -1;
  if (botUserId) {
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].user === botUserId) lastBotIdx = i;
    }
  }

  const nameCache = new Map<string, string>();
  const lines: string[] = [];
  for (const m of messages.slice(lastBotIdx + 1)) {
    if (m.ts === excludeTs || !m.text) continue;
    const text = stripComposerAttribution(m.text).trim();
    if (!text) continue;
    let label: string;
    if (m.bot_id) {
      label = m.username || m.bot_profile?.name || "bot";
    } else if (m.user) {
      if (!nameCache.has(m.user)) {
        const info = await client.users.info({ user: m.user }).catch(() => null);
        nameCache.set(m.user, info?.user?.real_name || info?.user?.name || m.user);
      }
      label = nameCache.get(m.user)!;
    } else {
      label = "unknown";
    }
    lines.push(`${label}: ${text}`);
  }
  return lines;
}
