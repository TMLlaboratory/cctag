import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import Bolt from "@slack/bolt";
import { WebSocketServer } from "ws";
import type { IncomingFile } from "../attachments.js";
import { loadHubConfig } from "../config.js";
import { TokenStore } from "./tokenStore.js";
import { WsRpc } from "../ws/rpc.js";
import {
  downloadSlackFile,
  formatThreadHistorySinceLastBotPost,
  displayNameFor,
  resolveUserMentions,
  uploadBinaryFile,
} from "../slack/notifier.js";
import { incomingFilesFrom, isPlainOrFileShare, type FileBearingEvent } from "../slack/files.js";

const { App } = Bolt;

/** Cap on the `fileOwner` authorization map (see rememberFileOwner). */
const MAX_TRACKED_FILES = 500;

interface RegisterPayload {
  ownerUserId: string;
  pairings: Array<{ channel: string; threadTs?: string }>;
}

function threadKey(channel: string, threadTs?: string): string {
  return threadTs ? `${channel}:${threadTs}` : channel;
}

function threadTsOf(event: { thread_ts?: string; ts: string }): string {
  return event.thread_ts ?? event.ts;
}

/**
 * One machine can run multiple Hubs (one per Slack workspace, via
 * CCTAG_ENV_FILE — see config.ts / spoke/index.ts's equivalent pairing-store
 * namespacing). Without this, every Hub on the box would share one
 * `~/.cctag-hub/tokens.json`, so a token issued for one workspace would also
 * be accepted by every other Hub's WebSocket server. The default (no
 * CCTAG_ENV_FILE) path is left unchanged for backwards compatibility.
 */
function tokenStorePath(): string | undefined {
  const envFile = process.env.CCTAG_ENV_FILE;
  if (!envFile) return undefined;
  const safe = envFile.replace(/[^a-zA-Z0-9]/g, "-");
  return join(homedir(), ".cctag-hub", `tokens-${safe}.json`);
}

async function runServer(): Promise<void> {
  const config = loadHubConfig();
  const tokenStore = new TokenStore(tokenStorePath());

  const spokesByOwner = new Map<string, WsRpc>();
  const threadOwner = new Map<string, string>();
  const messageLocations = new Map<string, { channel: string; ts: string; ownerUserId: string }>();
  // Which owner each forwarded attachment was offered to — the authorization
  // list `fetch_file` checks against. Bounded, because it grows with every
  // attachment the workspace ever sends and only the recent tail is ever
  // fetched (a Spoke asks within one turn of being told about the file).
  const fileOwner = new Map<string, string>();
  let msgSeq = 0;

  function rememberFileOwner(files: IncomingFile[], ownerUserId: string): void {
    for (const f of files) {
      fileOwner.set(f.id, ownerUserId);
      if (fileOwner.size > MAX_TRACKED_FILES) {
        // Map iteration is insertion-ordered, so this drops the oldest entry.
        const oldest = fileOwner.keys().next();
        if (!oldest.done) fileOwner.delete(oldest.value);
      }
    }
  }

  const app = new App({
    token: config.slackBotToken,
    appToken: config.slackAppToken,
    socketMode: true,
  });

  const authTest = await app.client.auth.test().catch(() => null);
  const botUserId = (authTest?.user_id as string | undefined) ?? undefined;
  /** Long-lived: the same handful of people mention each other repeatedly. */
  const mentionCache = new Map<string, string>();

  function spokeFor(ownerUserId: string): WsRpc | undefined {
    return spokesByOwner.get(ownerUserId);
  }

  async function notConnectedReply(channel: string, threadTs: string): Promise<void> {
    await app.client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: "⚠️ 起動していません。オーナーの cctag spoke デーモンが起動しているか確認してください。",
    });
  }

  // This server only ever expects a WebSocket upgrade on /spoke. Without a
  // request handler, Node accepts a plain HTTP request (health checks, a
  // browser hitting the bare domain, ...) but never responds — the client
  // just hangs until its own timeout. Answer fast instead.
  const httpServer = createServer((_req, res) => {
    res.writeHead(404, { "content-type": "text/plain" }).end("cctag hub: websocket endpoint only\n");
  });
  httpServer.requestTimeout = 15_000;
  const wss = new WebSocketServer({ server: httpServer, path: "/spoke" });

  wss.on("connection", (ws, req) => {
    // Read the bearer token from a header, not the URL query string — query
    // strings routinely end up in reverse-proxy and HTTP access logs (Caddy
    // included), which would otherwise leak every Spoke's credential to
    // anyone who can read those logs.
    const authHeader = req.headers.authorization ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : "";
    const issued = tokenStore.validate(token);
    if (!issued) {
      ws.close(4001, "invalid token");
      return;
    }

    const rpc = new WsRpc(ws);
    let registeredOwnerId: string | undefined;

    // A connected Spoke may only act on threads it actually owns (per
    // threadOwner) — an unowned thread (no pairing yet, e.g. mid-`connect`)
    // is allowed through, since that's the legitimate first-contact case.
    function canActOn(channel: string, threadTs: string): boolean {
      if (!registeredOwnerId) return false;
      const owner = threadOwner.get(threadKey(channel, threadTs));
      return owner === undefined || owner === registeredOwnerId;
    }

    rpc.onCall("register", (payload) => {
      const { ownerUserId, pairings } = payload as RegisterPayload;
      // The token is bound to one ownerUserId at issue time — otherwise any
      // token holder could register as (and knock offline) any other
      // owner's live connection and receive their future Slack events.
      if (ownerUserId !== issued.ownerUserId) {
        console.error(`[hub] rejected register: token "${issued.name}" is not authorized for owner ${ownerUserId}`);
        // Close rather than just returning {ok:false} — a misconfigured
        // Spoke should see its connection fail loudly, not silently sit
        // "registered" while every subsequent action gets rejected.
        ws.close(4003, "owner mismatch");
        return { ok: false };
      }
      registeredOwnerId = ownerUserId;
      const prior = spokesByOwner.get(ownerUserId);
      if (prior && prior !== rpc) prior.close();
      spokesByOwner.set(ownerUserId, rpc);

      for (const [key, owner] of threadOwner) {
        if (owner === ownerUserId) threadOwner.delete(key);
      }
      for (const p of pairings) threadOwner.set(threadKey(p.channel, p.threadTs), ownerUserId);

      console.log(`[hub] spoke registered: ${issued.name} -> ${ownerUserId} (${pairings.length} pairing(s))`);
      // Report the Hub's own file cap so the Spoke can clamp to it up front
      // rather than discovering it by pushing megabytes that get refused.
      return { ok: true, maxFileBytes: config.maxFileBytes };
    });

    rpc.onNotify("pairing_changed", (payload) => {
      const p = payload as { channel: string; threadTs?: string; action: "add" | "remove" };
      if (!registeredOwnerId) return;
      const key = threadKey(p.channel, p.threadTs);
      const owner = threadOwner.get(key);
      if (p.action === "add") {
        if (owner && owner !== registeredOwnerId) return; // already owned by someone else — ignore
        threadOwner.set(key, registeredOwnerId);
      } else if (p.action === "remove" && owner === registeredOwnerId) {
        threadOwner.delete(key);
      }
    });

    rpc.onCall("post_reply", async (payload) => {
      const p = payload as { channel: string; threadTs: string; text: string };
      if (!canActOn(p.channel, p.threadTs)) {
        console.error(`[hub] rejected post_reply from ${issued.name}: not authorized for ${p.channel}:${p.threadTs}`);
        return {};
      }
      await app.client.chat.postMessage({ channel: p.channel, thread_ts: p.threadTs || undefined, text: p.text });
      return {};
    });

    rpc.onCall("post_message", async (payload) => {
      const p = payload as { channel: string; threadTs: string; text: string; blocks?: unknown[] };
      if (!canActOn(p.channel, p.threadTs)) {
        console.error(`[hub] rejected post_message from ${issued.name}: not authorized for ${p.channel}:${p.threadTs}`);
        return { msgId: "" };
      }
      const res = await app.client.chat.postMessage({
        channel: p.channel,
        thread_ts: p.threadTs || undefined,
        text: p.text,
        blocks: p.blocks as never,
      });
      const msgId = `m${++msgSeq}`;
      messageLocations.set(msgId, { channel: p.channel, ts: res.ts as string, ownerUserId: registeredOwnerId! });
      return { msgId };
    });

    rpc.onCall("update_message", async (payload) => {
      const p = payload as { msgId: string; text: string; blocks?: unknown[] };
      const loc = messageLocations.get(p.msgId);
      if (!loc || loc.ownerUserId !== registeredOwnerId) return {};
      await app.client.chat.update({ channel: loc.channel, ts: loc.ts, text: p.text, blocks: p.blocks as never });
      return {};
    });

    // Permalinks don't expose message content (just a URL a visitor would
    // still need real Slack access to resolve), and the "already paired
    // elsewhere" hint legitimately looks up a permalink for a thread owned
    // by a *different* owner — so this one is intentionally left unscoped.
    rpc.onCall("get_permalink", async (payload) => {
      const p = payload as { channel: string; ts: string };
      const res = await app.client.chat.getPermalink({ channel: p.channel, message_ts: p.ts }).catch(() => null);
      return { permalink: res?.permalink ?? null };
    });

    rpc.onCall("get_thread_history", async (payload) => {
      const p = payload as { channel: string; threadTs: string; excludeTs: string };
      if (!canActOn(p.channel, p.threadTs)) return { lines: [] };
      const lines = await formatThreadHistorySinceLastBotPost(app.client, p.channel, p.threadTs, p.excludeTs, botUserId);
      return { lines };
    });

    rpc.onCall("upload_text_file", async (payload) => {
      const p = payload as { channel: string; threadTs: string; content: string; filename: string; title?: string; comment?: string };
      if (!canActOn(p.channel, p.threadTs)) {
        console.error(`[hub] rejected upload_text_file from ${issued.name}: not authorized for ${p.channel}:${p.threadTs}`);
        return {};
      }
      const common = { content: p.content, filename: p.filename, title: p.title, initial_comment: p.comment };
      await app.client.files.uploadV2(
        p.threadTs ? { channel_id: p.channel, thread_ts: p.threadTs, ...common } : { channel_id: p.channel, ...common },
      );
      return {};
    });

    // Rejections throw rather than returning an empty success: WsRpc turns a
    // thrown error into an `ok: false` result the Spoke's call() rejects on, so
    // a file the Hub refuses is reported to the user instead of being counted
    // as delivered. (The older handlers above keep their quiet return for
    // compatibility; a dropped status edit is not a dropped deliverable.)
    rpc.onCall("upload_file", async (payload) => {
      const p = payload as { channel: string; threadTs: string; contentB64: string; filename: string; title?: string; comment?: string };
      if (!canActOn(p.channel, p.threadTs)) {
        console.error(`[hub] rejected upload_file from ${issued.name}: not authorized for ${p.channel}:${p.threadTs}`);
        throw new Error(`not authorized to post in ${p.channel}`);
      }
      const bytes = Buffer.byteLength(p.contentB64, "base64");
      if (bytes > config.maxFileBytes) {
        console.error(`[hub] rejected upload_file from ${issued.name}: ${p.filename} exceeds CCTAG_MAX_FILE_MB`);
        throw new Error(
          `Hub側の上限を超えています（${(bytes / 1024 / 1024).toFixed(1)}MB > ${(config.maxFileBytes / 1024 / 1024).toFixed(1)}MB）`,
        );
      }
      await uploadBinaryFile(app.client, p.channel, p.threadTs, p);
      return {};
    });

    // Downloading is scoped to files this Hub itself handed to this owner (see
    // rememberFileOwner). Without that, any Spoke could name an arbitrary file
    // id and pull down a file from a channel it has no business reading —
    // the bot token can reach every file the bot can see, and only the Hub
    // holds that token.
    rpc.onCall("fetch_file", async (payload) => {
      const p = payload as { fileId: string; name?: string };
      if (!registeredOwnerId || fileOwner.get(p.fileId) !== registeredOwnerId) {
        console.error(`[hub] rejected fetch_file from ${issued.name}: ${p.fileId} was not offered to this owner`);
        return { contentB64: null };
      }
      // The cap is applied while streaming, so an oversized file is abandoned
      // mid-transfer instead of being fully buffered and then rejected.
      const contentB64 = await downloadSlackFile(
        app.client,
        config.slackBotToken,
        { id: p.fileId, name: p.name ?? p.fileId },
        config.maxFileBytes,
      );
      return { contentB64 };
    });

    ws.on("close", () => {
      if (registeredOwnerId && spokesByOwner.get(registeredOwnerId) === rpc) {
        spokesByOwner.delete(registeredOwnerId);
        console.log(`[hub] spoke disconnected: ${issued.name}`);
      }
    });
  });

  app.event("app_mention", async ({ event }) => {
    if ("bot_id" in event && event.bot_id) return;
    const channel = event.channel;
    const threadTs = threadTsOf(event);
    const userId = event.user ?? "";
    const key = threadKey(channel, threadTs);
    const ownerUserId = threadOwner.get(key) ?? userId;
    const spoke = spokeFor(ownerUserId);
    if (!spoke) {
      await notConnectedReply(channel, threadTs);
      return;
    }
    const files = incomingFilesFrom(event as unknown as FileBearingEvent);
    rememberFileOwner(files, ownerUserId);
    // Resolved here because only this side holds the token that can turn a user id
    // into a name; the Spoke would otherwise have to drop them.
    const text = await resolveUserMentions(app.client, event.text ?? "", botUserId, mentionCache);
    const userName = userId ? await displayNameFor(app.client, userId, mentionCache) : undefined;
    await spoke
      .call("app_mention", { channel, threadTs, userId, userName, text, ts: event.ts, files })
      .catch((err) => console.error("[hub] app_mention dispatch failed:", err));
  });

  app.event("message", async ({ event }) => {
    const msgEvent = event as unknown as {
      subtype?: string;
      bot_id?: string;
      channel: string;
      thread_ts?: string;
      text?: string;
    };
    // file_share is let through (rather than lumped in with joins/edits) so a
    // reply that answers a pending prompt *and* happens to carry an upload
    // still delivers its text — the attachment itself needs a mention.
    if (!isPlainOrFileShare(msgEvent.subtype) || msgEvent.bot_id || !msgEvent.thread_ts) return;
    const key = threadKey(msgEvent.channel, msgEvent.thread_ts);
    const ownerUserId = threadOwner.get(key);
    if (!ownerUserId) return; // unpaired thread — ordinary chatter, ignore
    const spoke = spokeFor(ownerUserId);
    if (!spoke) return;
    await spoke
      .call("message", { channel: msgEvent.channel, threadTs: msgEvent.thread_ts, text: msgEvent.text ?? "" })
      .catch((err) => console.error("[hub] message dispatch failed:", err));
  });

  app.action("pair_select", async ({ ack, body }) => {
    await ack();
    const actionBody = body as unknown as {
      user: { id: string };
      channel?: { id: string };
      message?: { ts: string; thread_ts?: string };
      actions: Array<{ selected_option?: { value: string } }>;
    };
    const channel = actionBody.channel?.id;
    const threadTs = actionBody.message?.thread_ts ?? actionBody.message?.ts;
    // Actually a paneId — see PairSelectContext.terminalId's doc comment.
    const terminalId = actionBody.actions[0]?.selected_option?.value;
    if (!channel || !threadTs || !terminalId) return;
    const spoke = spokeFor(actionBody.user.id);
    if (!spoke) {
      await notConnectedReply(channel, threadTs);
      return;
    }
    await spoke
      .call("pair_select", { channel, threadTs, userId: actionBody.user.id, terminalId })
      .catch((err) => console.error("[hub] pair_select dispatch failed:", err));
  });

  const actionRoute = (kind: "aq_answer" | "perm_choice") =>
    async ({ ack, body }: { ack: () => Promise<void>; body: unknown }) => {
      await ack();
      const actionBody = body as {
        channel?: { id: string };
        message?: { ts: string; thread_ts?: string };
        user?: { id?: string };
        actions: Array<{ value?: string }>;
      };
      const channel = actionBody.channel?.id;
      const threadTs = actionBody.message?.thread_ts ?? actionBody.message?.ts;
      const raw = actionBody.actions[0]?.value;
      if (!channel || !threadTs || !raw) return;
      const key = threadKey(channel, threadTs);
      const ownerUserId = threadOwner.get(key);
      const spoke = ownerUserId ? spokeFor(ownerUserId) : undefined;
      if (!spoke) {
        await notConnectedReply(channel, threadTs);
        return;
      }
      // Who pressed it. Slack guarantees this field, so unlike anything typed into
      // a message it cannot be forged — which is what makes it worth recording.
      // Resolved here because the Spoke has no token to turn an id into a name.
      const actorUserId = actionBody.user?.id;
      const actorName = actorUserId ? await displayNameFor(app.client, actorUserId, mentionCache) : undefined;
      await spoke
        .call(kind, { channel, threadTs, value: raw, actorUserId, actorName })
        .catch((err) => console.error(`[hub] ${kind} dispatch failed:`, err));
    };
  app.action(/^aq_answer_/, actionRoute("aq_answer"));
  app.action(/^perm_choice_/, actionRoute("perm_choice"));

  await new Promise<void>((resolve) => httpServer.listen(config.wsPort, resolve));
  console.log(`[hub] WebSocket server listening on :${config.wsPort} (path /spoke)`);

  await app.start();
  console.log("[hub] ⚡️ Slack connection running (Socket Mode)");
}

function runTokenCli(argv: string[]): void {
  const tokenStore = new TokenStore(tokenStorePath());
  const [cmd, name, ownerUserId] = argv;
  switch (cmd) {
    case "issue": {
      if (!name || !ownerUserId) throw new Error("usage: token issue <name> <ownerUserId>");
      const issued = tokenStore.issue(name, ownerUserId);
      console.log(`Issued token for "${name}" (owner ${ownerUserId}):`);
      console.log(issued.token);
      console.log(
        "\nSet this as CCTAG_SPOKE_TOKEN, and set CCTAG_OWNER_USER_ID to the same " +
          `${ownerUserId}, in that person's spoke .env file.`,
      );
      return;
    }
    case "revoke": {
      if (!name) throw new Error("usage: token revoke <name>");
      const removed = tokenStore.revoke(name);
      console.log(removed ? `Revoked token(s) for "${name}".` : `No token found for "${name}".`);
      return;
    }
    case "list": {
      for (const t of tokenStore.list()) {
        console.log(`${t.name}\towner ${t.ownerUserId}\tissued ${t.issuedAt}\t${t.token}`);
      }
      return;
    }
    default:
      throw new Error(`unknown token subcommand: ${cmd}\nusage: token <issue|revoke|list> [name]`);
  }
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  if (cmd === "token") {
    runTokenCli(rest);
    return;
  }
  await runServer();
}

main().catch((err) => {
  console.error("cctag-hub failed:", err);
  process.exit(1);
});
