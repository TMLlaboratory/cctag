import type { WebClient } from "@slack/web-api";
import type { AttachmentLimits, IncomingFile } from "../attachments.js";
import type { MessageHandle, Notifier } from "../notifier.js";
import { stripComposerAttribution } from "../commands.js";

export class SlackNotifier implements Notifier {
  private botUserId: string | undefined;

  constructor(
    private readonly client: WebClient,
    private readonly token: string,
    /** Held by reference so it stays in step with the engine's own cap. */
    private readonly limits: AttachmentLimits,
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
    return downloadSlackFile(this.client, this.token, file, this.limits.maxFileBytes);
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
 * Downloads a Slack-hosted file, refusing to hold more than `maxBytes` of it in
 * memory at any point. Shared by the standalone notifier and the Hub's
 * `fetch_file` RPC handler — both hold the bot token, which
 * `url_private_download` requires as a bearer header (the URL alone returns
 * an HTML sign-in page, not the bytes, and does so with a 200, hence the
 * content-type check).
 *
 * The cap is enforced *while* reading rather than after: `arrayBuffer()` would
 * materialize the whole response first, so a file whose event metadata reported
 * no size (or lied about it) could exhaust memory before any check ran — the
 * Hub relays every Spoke's transfers, so that is a shared-process risk, not
 * just a local one.
 */
export async function downloadSlackFile(
  client: WebClient,
  botToken: string,
  file: IncomingFile,
  maxBytes: number,
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

  // Cheapest rejection first: a declared length over the cap needs no transfer.
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    console.error(`[slack] refused ${file.name}: content-length ${declared} exceeds the ${maxBytes}-byte cap`);
    return null;
  }
  if (!res.body) return null;

  const chunks: Buffer[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      console.error(`[slack] refused ${file.name}: stream exceeded the ${maxBytes}-byte cap`);
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("base64");
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
/**
 * Replaces `<@U…>` mention markup with the person's display name.
 *
 * Needed because only the side holding the bot token can resolve a user id, and
 * everything downstream had to cope without it: live messages had every mention
 * deleted outright, so "「@佐藤 の指摘と @松浦 の案」" reached the agent as
 * "「 の指摘と  の案」" and the question no longer said anything; thread history
 * kept the raw ids, which are no more use to a reader than to a model.
 *
 * The bot's own mention is left alone — it is the command trigger, and the Spoke
 * strips it (commands.ts's stripMention) once nothing else looks like markup.
 * Lookups are cached across a call, and a failed lookup leaves the id in place
 * rather than deleting text nobody can recover.
 */
/**
 * A person's display name, cached. Shared by mention resolution and by whoever
 * needs to record who did something.
 *
 * Returns undefined rather than the raw id when the lookup fails: an id in place
 * of a name reads as noise, and callers can leave the field out instead.
 */
export async function displayNameFor(
  client: WebClient,
  userId: string,
  cache = new Map<string, string>(),
): Promise<string | undefined> {
  const cached = cache.get(userId);
  if (cached) return cached;
  const info = await client.users.info({ user: userId }).catch(() => null);
  const name = info?.user?.profile?.display_name || info?.user?.real_name || info?.user?.name;
  if (!name) return undefined;
  cache.set(userId, name);
  return name;
}

export async function resolveUserMentions(
  client: WebClient,
  text: string,
  botUserId?: string,
  cache = new Map<string, string>(),
): Promise<string> {
  const ids = [...new Set([...text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1]))];
  for (const id of ids) {
    if (id === botUserId) continue;
    await displayNameFor(client, id, cache);
  }
  return text.replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, (whole, id: string) => {
    if (id === botUserId) return whole;
    const name = cache.get(id);
    return name ? `@${name}` : whole;
  });
}

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
  // Separate from nameCache on purpose: that one falls back to the raw id when a
  // lookup fails, which is fine as a label but would turn a mention into "@U05RU…"
  // — worse than leaving the markup alone.
  const mentionCache = new Map<string, string>();
  const lines: string[] = [];
  for (const m of messages.slice(lastBotIdx + 1)) {
    if (m.ts === excludeTs || !m.text) continue;
    const text = await resolveUserMentions(client, stripComposerAttribution(m.text).trim(), botUserId, mentionCache);
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
