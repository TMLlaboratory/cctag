import Bolt from "@slack/bolt";
import type { Config } from "../config.js";
import { HerdrClient } from "../herdr/client.js";
import { PairingStore } from "../pairing.js";
import { TurnEngine } from "../turn.js";
import { CommandHandler, stripComposerAttribution, stripMention } from "../commands.js";
import { BackgroundWatcher } from "../watcher.js";
import { incomingFilesFrom, isPlainOrFileShare, type FileBearingEvent } from "./files.js";
import { displayNameFor, resolveUserMentions, SlackNotifier } from "./notifier.js";

const { App } = Bolt;

function threadTsOf(event: { thread_ts?: string; ts: string }): string {
  return event.thread_ts ?? event.ts;
}

export async function buildApp(config: Config) {
  const herdr = new HerdrClient(config.herdrBin);
  const pairingStore = new PairingStore();

  const app = new App({
    token: config.slackBotToken,
    appToken: config.slackAppToken,
    socketMode: true,
  });

  // Needed to leave cctag's own mention in place while resolving everyone else's:
  // that one is the command trigger and stripMention takes it off afterwards.
  const authTest = await app.client.auth.test().catch(() => null);
  const botUserId = (authTest?.user_id as string | undefined) ?? undefined;

  const limits = { maxFileBytes: config.maxFileBytes, maxFileCount: config.maxFileCount };
  const notifier = new SlackNotifier(app.client, config.slackBotToken, limits);
  const turnEngine = new TurnEngine(
    herdr,
    notifier,
    { turnTimeoutMs: config.turnTimeoutMs, pollIntervalMs: config.pollIntervalMs, limits },
    pairingStore,
  );
  const commands = new CommandHandler(herdr, pairingStore, turnEngine, notifier, config.ownerUserId);
  new BackgroundWatcher(herdr, pairingStore, turnEngine, notifier).start();

  const mentionCache = new Map<string, string>();
  app.event("app_mention", async ({ event }) => {
    if ("bot_id" in event && event.bot_id) return;
    // Other people's mentions become names before the bot's own is stripped, or
    // "「@佐藤 の指摘」" would reach the agent as "「 の指摘」". Deliberately only on
    // this path: the plain-message path ignores anything with a mention in it,
    // which is what keeps human-to-human chatter out of a pending prompt, and
    // resolving there would slip past that guard.
    const resolved = await resolveUserMentions(app.client, event.text ?? "", botUserId, mentionCache);
    const text = stripMention(stripComposerAttribution(resolved));
    const senderId = event.user ?? "";
    await commands.handleMention({
      channel: event.channel,
      threadTs: threadTsOf(event),
      userId: senderId,
      userName: senderId ? await displayNameFor(app.client, senderId, mentionCache) : undefined,
      text,
      ts: event.ts,
      files: incomingFilesFrom(event as unknown as FileBearingEvent),
    });
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
    await commands.handlePairSelect({ channel, threadTs, userId: actionBody.user.id, terminalId });
  });

  app.action(/^aq_answer_/, async ({ ack, body }) => {
    await ack();
    const actionBody = body as unknown as {
      channel?: { id: string };
      message?: { ts: string; thread_ts?: string };
      user?: { id?: string };
      actions: Array<{ value?: string }>;
    };
    const channel = actionBody.channel?.id;
    const threadTs = actionBody.message?.thread_ts ?? actionBody.message?.ts;
    const raw = actionBody.actions[0]?.value;
    if (!channel || !threadTs || !raw) return;
    const value = JSON.parse(raw) as { t: string; p: number; o: number };
    const actorUserId = actionBody.user?.id;
    await commands.handleAskUserQuestionButton({
      channel,
      threadTs,
      terminalId: value.t,
      promptId: value.p,
      optionIndex: value.o,
      actorUserId,
      actorName: actorUserId ? await displayNameFor(app.client, actorUserId, mentionCache) : undefined,
    });
  });

  app.action(/^perm_choice_/, async ({ ack, body }) => {
    await ack();
    const actionBody = body as unknown as {
      channel?: { id: string };
      message?: { ts: string; thread_ts?: string };
      user?: { id?: string };
      actions: Array<{ value?: string }>;
    };
    const channel = actionBody.channel?.id;
    const threadTs = actionBody.message?.thread_ts ?? actionBody.message?.ts;
    const raw = actionBody.actions[0]?.value;
    if (!channel || !threadTs || !raw) return;
    const value = JSON.parse(raw) as { t: string; p: number; n: string };
    const actorUserId = actionBody.user?.id;
    await commands.handlePermissionButton({
      channel,
      threadTs,
      terminalId: value.t,
      promptId: value.p,
      num: value.n,
      actorUserId,
      actorName: actorUserId ? await displayNameFor(app.client, actorUserId, mentionCache) : undefined,
    });
  });

  // Free-text answers to a pending AskUserQuestion: any plain thread reply
  // (no mention needed) while that thread's paired turn is awaiting-question.
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
    if (!isPlainOrFileShare(msgEvent.subtype) || msgEvent.bot_id) return;
    if (!msgEvent.thread_ts) return;
    const text = stripComposerAttribution(msgEvent.text ?? "").trim();
    if (!text || /<@[^>]+>/.test(text)) return; // mentions are handled by app_mention

    await commands.handleFreeTextMessage({ channel: msgEvent.channel, threadTs: msgEvent.thread_ts, text });
  });

  return app;
}
