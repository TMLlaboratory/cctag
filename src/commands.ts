import type { IncomingFile } from "./attachments.js";
import type { HerdrClient } from "./herdr/client.js";
import { PairingStore } from "./pairing.js";
import type { TurnEngine } from "./turn.js";
import type { Notifier } from "./notifier.js";
import { agentPickerBlocks, type AgentPickerEntry } from "./slack/blocks.js";
import { driverFor, type AgentDriver } from "./agents/driver.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const CLAUDE_HELP_TEXT = [
  "*cctag の使い方*",
  "• `@cctag connect` — このスレッドを Claude Code インスタンスに接続（オーナーのみ）",
  "• `@cctag disconnect` — 接続を解除（オーナーのみ）",
  "• `@cctag status` — 接続状態を表示",
  "• `@cctag list` — 稼働中のインスタンス一覧",
  "• `@cctag model <name>` — Claude Code のモデルを切り替え（例: `model opus`）",
  "• `@cctag mode <name>` — モードを切り替え（`manual` / `accept-edits` / `plan` / `auto`）",
  "• `@cctag plan` — Plan Mode を有効化（`mode plan` と同じ）",
  "• `@cctag log [指示]` — cctagの最終発言以降のスレッド履歴を読み込んで対応（例: `log`, `log 上記を直してpushして`）",
  "• `@cctag <メッセージ>` — 接続済みインスタンスにメッセージを送信",
  "• 画像やファイルを添付して `@cctag` すると、そのままインスタンスに渡されます（画像は画像として認識されます）",
  "• インスタンスが `.cctag/outbox/` に置いたファイルは、ターン終了時にこのスレッドへ自動添付されます",
].join("\n");

const CODEX_HELP_TEXT = [
  "*cctag の使い方（Codex CLI）*",
  "• `@cctag connect` — このスレッドを Codex CLI インスタンスに接続（オーナーのみ）",
  "• `@cctag disconnect` — 接続を解除（オーナーのみ）",
  "• `@cctag status` — 接続状態を表示",
  "• `@cctag list` — 稼働中のインスタンス一覧",
  "• `@cctag model <name> [level]` — モデル・推論レベルを切り替え（例: `model gpt-5.6-sol high`）",
  "• `@cctag log [指示]` — cctagの最終発言以降のスレッド履歴を読み込んで対応（例: `log`, `log 上記を直してpushして`）",
  "• `@cctag <メッセージ>` — 接続済みインスタンスにメッセージを送信",
  "• 添付ファイルはパスとして渡されます（Codex CLI は画像も読み取れます）",
  "• インスタンスが `.cctag/outbox/` に置いたファイルは、ターン終了時にこのスレッドへ自動添付されます",
  "（`mode` / `plan` は Codex CLI では利用できません）",
].join("\n");

/** Unpaired threads (driver unknown) and Claude Code panes get the full,
 *  byte-identical help text they always have; other agents get a variant
 *  without the capabilities they don't support. */
function helpTextFor(driver: AgentDriver | null): string {
  if (driver && driver.kind !== "claude") return CODEX_HELP_TEXT;
  return CLAUDE_HELP_TEXT;
}

const MODEL_COMMAND_RE = /^model\s+(\S[\s\S]*)$/i;
const MODE_COMMAND_RE = /^mode\s+(\S+)$/i;
const LOG_COMMAND_RE = /^log(?:\s+([\s\S]+))?$/i;

export interface MentionContext {
  channel: string;
  threadTs: string;
  userId: string;
  /** Already mention-stripped and composer-attribution-stripped. */
  text: string;
  /** This message's own Slack ts — used by `log` to exclude itself from fetched thread history. */
  ts: string;
  /** Files attached to the mention (pasting an image in Slack uploads one). */
  files?: IncomingFile[];
}

export interface PairSelectContext {
  channel: string;
  threadTs: string;
  userId: string;
  // Actually a paneId (agentPickerBlocks embeds a.paneId as the button
  // value) — kept named terminalId on the wire so a Hub deployed from an
  // older build (Hub–Spoke mode: Hub and Spoke ship independently) still
  // round-trips the value under the field name it knows.
  terminalId: string;
}

export interface AskUserQuestionButtonContext {
  channel: string;
  threadTs: string;
  // Despite the name, this is the paneId round-tripped through the Slack
  // button's embedded value (see turn.ts's askUserQuestionBlocks call and
  // slack/app.ts's `value.t` decode) — TurnEngine keys its turns by paneId.
  terminalId: string;
  promptId: number;
  optionIndex: number;
}

export interface PermissionButtonContext {
  channel: string;
  threadTs: string;
  // See AskUserQuestionButtonContext.terminalId — same paneId-via-`t` round trip.
  terminalId: string;
  promptId: number;
  num: string;
}

export interface FreeTextContext {
  channel: string;
  threadTs: string;
  /** Already composer-attribution-stripped; mentions already excluded by the caller. */
  text: string;
}

/**
 * All the Slack-SDK-agnostic business logic behind `@cctag` commands and
 * button clicks. Used directly in standalone mode (slack/app.ts) and, in
 * Hub–Spoke mode, on the Spoke side (driven by events forwarded from the Hub
 * over a WebSocket instead of Bolt).
 */
export class CommandHandler {
  constructor(
    private readonly herdr: HerdrClient,
    private readonly pairingStore: PairingStore,
    private readonly turnEngine: TurnEngine,
    private readonly notifier: Notifier,
    private readonly ownerUserId: string,
  ) {}

  isOwner(userId: string): boolean {
    return userId === this.ownerUserId;
  }

  async handleMention(ctx: MentionContext): Promise<void> {
    const { channel, threadTs, userId, text, ts } = ctx;
    const files = ctx.files ?? [];

    // An attachment is unambiguously a turn, never a command: `connect` and
    // friends have nothing to do with a file, and routing a file-bearing
    // mention through the command switch would send "@cctag" + a screenshot
    // (empty text) to the help branch instead of to the agent.
    if (files.length > 0) {
      await this.dispatchTurn(channel, threadTs, userId, text, files);
      return;
    }

    // Only single-word commands are recognized; anything else (including any
    // message containing whitespace/newlines) falls through to a turn below
    // using the FULL text, not a split fragment of it.
    const singleWordCmd = /^\S+$/.test(text) ? text.toLowerCase() : undefined;

    const modelMatch = MODEL_COMMAND_RE.exec(text);
    if (modelMatch) {
      const pairing = this.pairingStore.get(channel, threadTs);
      if (!pairing) {
        await this.notifier.postReply(
          channel,
          threadTs,
          "接続されていません。オーナーがこのスレッドで「@cctag connect」を実行し、インスタンスを選択してください。",
        );
        return;
      }
      if (this.turnEngine.isBusy(pairing.paneId)) {
        await this.notifier.postReply(channel, threadTs, "⏳ 現在の応答が完了するまでお待ちください。");
        return;
      }
      const agent = await this.herdr.agentGet(pairing.paneId);
      if (!agent) {
        await this.notifier.postReply(channel, threadTs, "⚠️ インスタンスが見つかりません。");
        return;
      }
      const driver = driverFor(agent.agent);
      this.turnEngine.markBusy(pairing.paneId);
      try {
        const reply = await driver.runModelCommand(this.herdr, agent, modelMatch[1].trim());
        await this.notifier.postReply(channel, threadTs, reply);
      } finally {
        this.turnEngine.clearBusy(pairing.paneId);
      }
      return;
    }

    const modeMatch = MODE_COMMAND_RE.exec(text);
    if (modeMatch) {
      const pairing = this.pairingStore.get(channel, threadTs);
      if (!pairing) {
        await this.notifier.postReply(
          channel,
          threadTs,
          "接続されていません。オーナーがこのスレッドで「@cctag connect」を実行し、インスタンスを選択してください。",
        );
        return;
      }
      const agent = await this.herdr.agentGet(pairing.paneId);
      if (!agent) {
        await this.notifier.postReply(channel, threadTs, "⚠️ インスタンスが見つかりません。");
        return;
      }
      const driver = driverFor(agent.agent);
      if (!driver.modes) {
        await this.notifier.postReply(channel, threadTs, `⚠️ \`mode\` は ${driver.displayName} では利用できません。`);
        return;
      }
      const target = driver.modes.aliases[modeMatch[1].toLowerCase()];
      if (!target) {
        await this.notifier.postReply(
          channel,
          threadTs,
          `⚠️ 不明なモード「${modeMatch[1]}」。使えるのは: ${driver.modes.ring.join(" / ")}`,
        );
        return;
      }
      await this.runModeCommand(channel, threadTs, pairing.paneId, driver, target);
      return;
    }

    const logMatch = LOG_COMMAND_RE.exec(text);
    if (logMatch) {
      await this.handleLog(channel, threadTs, userId, ts, logMatch[1]?.trim());
      return;
    }

    switch (singleWordCmd) {
      case "plan": {
        const pairing = this.pairingStore.get(channel, threadTs);
        if (!pairing) {
          await this.notifier.postReply(
            channel,
            threadTs,
            "接続されていません。オーナーがこのスレッドで「@cctag connect」を実行し、インスタンスを選択してください。",
          );
          return;
        }
        const agent = await this.herdr.agentGet(pairing.paneId);
        if (!agent) {
          await this.notifier.postReply(channel, threadTs, "⚠️ インスタンスが見つかりません。");
          return;
        }
        const driver = driverFor(agent.agent);
        if (!driver.modes) {
          await this.notifier.postReply(channel, threadTs, `⚠️ \`plan\` は ${driver.displayName} では利用できません。`);
          return;
        }
        // `plan` is just `mode plan` — cycle to plan mode via Shift+Tab
        // rather than the `/plan` slash command, so all four modes share
        // one reliable mechanism.
        await this.runModeCommand(channel, threadTs, pairing.paneId, driver, "plan");
        return;
      }
      case "connect": {
        if (!this.isOwner(userId)) {
          await this.notifier.postReply(channel, threadTs, "⚠️ `connect` はオーナーのみ実行できます。");
          return;
        }
        const agents = await this.herdr.agentList();
        const entries: AgentPickerEntry[] = agents.map((agent) => ({
          agent,
          title: driverFor(agent.agent).readTitle?.(agent.cwd, agent.sessionId) ?? null,
        }));
        await this.notifier.postMessage(channel, threadTs, "接続するインスタンスを選択してください", agentPickerBlocks(entries));
        return;
      }
      case "disconnect": {
        if (!this.isOwner(userId)) {
          await this.notifier.postReply(channel, threadTs, "⚠️ `disconnect` はオーナーのみ実行できます。");
          return;
        }
        const pairing = this.pairingStore.get(channel, threadTs);
        if (!pairing) {
          await this.notifier.postReply(channel, threadTs, "このスレッドは接続されていません。");
          return;
        }
        await this.turnEngine.abortTurn(pairing.paneId);
        this.pairingStore.remove(pairing.key);
        await this.notifier.postReply(channel, threadTs, "🔌 接続を解除しました。");
        return;
      }
      case "status": {
        const pairing = this.pairingStore.get(channel, threadTs);
        if (!pairing) {
          await this.notifier.postReply(channel, threadTs, "このスレッドは接続されていません。");
          return;
        }
        const agent = await this.herdr.agentGet(pairing.paneId);
        const statusLine = agent
          ? `状態: ${agent.agentStatus} / cwd: ${agent.cwd}`
          : "⚠️ インスタンスが見つかりません（切断されている可能性があります）";
        await this.notifier.postReply(channel, threadTs, `🔗 接続先: ${pairing.cwd}\n${statusLine}`);
        return;
      }
      case "list": {
        const agents = await this.herdr.agentList();
        const pairings = this.pairingStore.list();
        const lines = agents.map((a) => {
          const paired = pairings.find((p) => p.paneId === a.paneId);
          const mark = paired ? "🔗" : "・";
          return `${mark} ${a.agentStatus.padEnd(8)} ${a.cwd}`;
        });
        await this.notifier.postReply(
          channel,
          threadTs,
          lines.length ? "```\n" + lines.join("\n") + "\n```" : "稼働中のインスタンスがありません。",
        );
        return;
      }
      case "help":
      case undefined: {
        if (!text || singleWordCmd === "help") {
          const pairing = this.pairingStore.get(channel, threadTs);
          let driver: AgentDriver | null = null;
          if (pairing) {
            const agent = await this.herdr.agentGet(pairing.paneId).catch(() => null);
            driver = agent ? driverFor(agent.agent) : null;
          }
          await this.notifier.postReply(channel, threadTs, helpTextFor(driver));
          return;
        }
        break; // multi-word text with no recognized command -> fall through to turn dispatch
      }
    }

    // Anything else: treat as a turn message.
    await this.dispatchTurn(channel, threadTs, userId, text, []);
  }

  /**
   * The common tail of every path that ends in "send this to the agent":
   * resolve the pairing, download any attachments, and start the turn.
   */
  private async dispatchTurn(
    channel: string,
    threadTs: string,
    userId: string,
    text: string,
    files: IncomingFile[],
  ): Promise<void> {
    const pairing = this.pairingStore.get(channel, threadTs);
    if (!pairing) {
      await this.notifier.postReply(
        channel,
        threadTs,
        "接続されていません。オーナーがこのスレッドで「@cctag connect」を実行し、インスタンスを選択してください。",
      );
      return;
    }
    if (this.turnEngine.isBusy(pairing.paneId)) {
      await this.notifier.postReply(channel, threadTs, "⏳ 現在の応答が完了するまでお待ちください。");
      return;
    }

    try {
      // Attachments are downloaded inside startTurn, not here: the busy check
      // above is only meaningful if nothing slow happens between it and the
      // pane actually being reserved.
      await this.turnEngine.startTurn(pairing, userId, text, { files });
    } catch (err) {
      if (err instanceof Error && err.message === "agent-not-found") {
        this.pairingStore.remove(pairing.key);
        await this.notifier.postReply(channel, threadTs, "⚠️ インスタンスが見つかりません。ペアリングを解除しました。");
        return;
      }
      // startTurn re-checks busy under its own synchronous reservation, so two
      // messages arriving together can reach it past the check above — that's
      // the ordinary "wait your turn" case, not an error worth showing raw.
      if (err instanceof Error && err.message === "busy") {
        await this.notifier.postReply(channel, threadTs, "⏳ 現在の応答が完了するまでお待ちください。");
        return;
      }
      await this.notifier.postReply(channel, threadTs, `❌ エラー: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * `@cctag mode <name>` — switches the paired session to one of the
   * driver's Shift+Tab-style modes (only Claude Code has these; callers
   * gate on `driver.modes !== null` before calling this). Reads the current
   * mode off the pane footer and cycles one press at a time, re-reading
   * after each, until the footer shows the target. Closed-loop rather than
   * a computed press count, so it's robust to the ring order or footer
   * wording differing across CLI versions.
   */
  private async runModeCommand(
    channel: string,
    threadTs: string,
    paneId: string,
    driver: AgentDriver,
    target: string,
  ): Promise<void> {
    const modes = driver.modes;
    if (!modes) return; // callers gate on this; defensive no-op if reached anyway
    if (this.turnEngine.isBusy(paneId)) {
      await this.notifier.postReply(channel, threadTs, "⏳ 現在の応答が完了するまでお待ちください。");
      return;
    }
    const agent = await this.herdr.agentGet(paneId);
    if (!agent) {
      await this.notifier.postReply(channel, threadTs, "⚠️ インスタンスが見つかりません。");
      return;
    }

    this.turnEngine.markBusy(paneId);
    try {
      let current = modes.parseCurrent(await this.herdr.paneRead(agent.paneId, { source: "recent", lines: 12 }));
      if (current === null) {
        // Don't blind-cycle from an unknown state — pressing Shift+Tab would
        // change the mode with no way to know to what, or to restore it.
        await this.notifier.postReply(channel, threadTs, "⚠️ 現在のモードを判別できませんでした（切り替えは行っていません）。");
        return;
      }
      if (current === target) {
        await this.notifier.postReply(channel, threadTs, `✅ 既にモードは「${target}」です。`);
        return;
      }

      // Press at most one full ring. A full cycle lands back on the starting
      // mode, so if the target isn't reachable (not in this CLI build) we
      // end up exactly where we began rather than in some other mode while
      // reporting failure.
      for (let i = 0; i < modes.ring.length && current !== target; i++) {
        await modes.cycle(this.herdr, agent.paneId);
        await sleep(400);
        current = modes.parseCurrent(await this.herdr.paneRead(agent.paneId, { source: "recent", lines: 12 }));
      }

      if (current === target) {
        await this.notifier.postReply(channel, threadTs, `✅ モードを「${target}」に切り替えました。`);
      } else {
        await this.notifier.postReply(
          channel,
          threadTs,
          `⚠️ モード「${target}」に切り替えられませんでした（このバージョンの ${driver.displayName} には無い可能性があります）。元のモードに戻しました。現在: ${current ?? "不明"}`,
        );
      }
    } finally {
      this.turnEngine.clearBusy(paneId);
    }
  }

  /**
   * `@cctag log [instruction]` — catches the paired instance up on thread
   * conversation it wasn't mentioned in (e.g. a review posted by another
   * Slack bot/human), scoped to messages posted after cctag's own last
   * message in this thread. With no instruction, defaults to asking the
   * agent to act on whatever the log contains.
   */
  private async handleLog(channel: string, threadTs: string, userId: string, ts: string, instruction?: string): Promise<void> {
    const pairing = this.pairingStore.get(channel, threadTs);
    if (!pairing) {
      await this.notifier.postReply(
        channel,
        threadTs,
        "接続されていません。オーナーがこのスレッドで「@cctag connect」を実行し、インスタンスを選択してください。",
      );
      return;
    }
    if (this.turnEngine.isBusy(pairing.paneId)) {
      await this.notifier.postReply(channel, threadTs, "⏳ 現在の応答が完了するまでお待ちください。");
      return;
    }
    if (!this.notifier.getThreadHistorySinceLastBotPost) {
      await this.notifier.postReply(channel, threadTs, "⚠️ このモードでは `log` コマンドは使えません。");
      return;
    }

    let lines: string[];
    try {
      lines = await this.notifier.getThreadHistorySinceLastBotPost(channel, threadTs, ts);
    } catch (err) {
      await this.notifier.postReply(channel, threadTs, `❌ 履歴取得エラー: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (lines.length === 0) {
      await this.notifier.postReply(channel, threadTs, "cctagの最終発言以降、新しいメッセージはありませんでした。");
      return;
    }

    const combined = [
      "[Slackスレッドの履歴（cctagの最終発言以降）]",
      lines.join("\n"),
      "---",
      instruction || "上記を踏まえて対応してください。",
    ].join("\n");

    try {
      await this.turnEngine.startTurn(pairing, userId, combined);
    } catch (err) {
      if (err instanceof Error && err.message === "agent-not-found") {
        this.pairingStore.remove(pairing.key);
        await this.notifier.postReply(channel, threadTs, "⚠️ インスタンスが見つかりません。ペアリングを解除しました。");
        return;
      }
      await this.notifier.postReply(channel, threadTs, `❌ エラー: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async handlePairSelect(ctx: PairSelectContext): Promise<void> {
    const { channel, threadTs, userId, terminalId: paneId } = ctx;
    if (!this.isOwner(userId)) {
      await this.notifier.postReply(channel, threadTs, "⚠️ オーナーのみ接続できます。");
      return;
    }

    const agent = await this.herdr.agentGet(paneId);
    if (!agent) {
      await this.notifier.postReply(channel, threadTs, "⚠️ インスタンスが見つかりません。");
      return;
    }

    const existing = this.pairingStore.byPane(paneId);
    if (existing) {
      // The old pairing might be a zombie: its paneId can still exist in
      // herdr (e.g. Claude Code was exited and a new session started in the
      // same pane) even though the conversation it was paired to is long
      // gone. Only block on a *live* conflict with someone else's pairing —
      // a stale entry, or the same owner re-picking a pane they already had
      // paired, gets moved automatically instead.
      if (existing.pairedBy === userId) {
        this.pairingStore.remove(existing.key);
        if (existing.key !== PairingStore.threadKey(channel, threadTs)) {
          await this.notifier.postReply(
            existing.channel,
            existing.threadTs ?? "",
            "🔌 このインスタンスは別のスレッドに接続し直されました。",
          );
        }
      } else {
        const link = await this.notifier.getPermalink?.(existing.channel, existing.threadTs ?? "").catch(() => null);
        await this.notifier.postReply(
          channel,
          threadTs,
          `⚠️ このインスタンスは既に他のスレッドに接続されています${link ? `: ${link}` : ""}`,
        );
        return;
      }
    }

    this.pairingStore.add({
      key: PairingStore.threadKey(channel, threadTs),
      channel,
      threadTs,
      paneId,
      terminalId: agent.terminalId,
      cwd: agent.cwd,
      agent: agent.agent,
      pairedBy: userId,
      pairedAt: new Date().toISOString(),
    });

    const driver = driverFor(agent.agent);
    const suffix = driver.kind === "claude" ? "" : `（${driver.displayName}）`;
    await this.notifier.postReply(channel, threadTs, `✅ 接続しました: ${agent.cwd}${suffix}`);
  }

  async handleAskUserQuestionButton(ctx: AskUserQuestionButtonContext): Promise<void> {
    const result = await this.turnEngine.answerQuestionButton(ctx.terminalId, ctx.promptId, ctx.optionIndex);
    if (!result.ok) {
      await this.notifier.postReply(ctx.channel, ctx.threadTs, "⚠️ この質問は既に回答済みです。");
    }
  }

  async handlePermissionButton(ctx: PermissionButtonContext): Promise<void> {
    const result = await this.turnEngine.answerPermissionButton(ctx.terminalId, ctx.promptId, ctx.num);
    if (!result.ok) {
      await this.notifier.postReply(ctx.channel, ctx.threadTs, "⚠️ このリクエストは既に処理済みです。");
    }
  }

  /**
   * Free-text answer to a pending prompt (no mention needed). Tries an
   * AskUserQuestion answer first; if nothing's pending there, tries routing
   * it as ExitPlanMode feedback ("Tell Claude what to change"). Silently a
   * no-op if neither is pending.
   *
   * Text only, deliberately: both answer mechanisms drive the TUI's option
   * rows with arrow keys and inline placeholder replacement, which is not a
   * place to be injecting file paths. Sending a file needs an explicit
   * `@cctag` mention, same as starting any other turn.
   */
  async handleFreeTextMessage(ctx: FreeTextContext): Promise<void> {
    const pairing = this.pairingStore.get(ctx.channel, ctx.threadTs);
    if (!pairing) return;
    const asQuestion = await this.turnEngine.answerQuestionFreeText(pairing.paneId, ctx.text);
    if (asQuestion.ok) return;
    await this.turnEngine.answerPlanFeedback(pairing.paneId, ctx.text);
  }
}

export function stripMention(text: string): string {
  return text.replace(/<@[^>]+>/g, "").trim();
}

/**
 * Some Slack clients (observed: an AI-assisted composer used in one
 * workspace) append a trailing "*Sent using X* <@bot>"-style attribution to
 * every message. It's a single trailing "*bold text* <@mention>" run — not
 * necessarily on its own line — so match that specific shape at the very end
 * of the raw text (before mention-stripping) rather than assuming a newline.
 */
export function stripComposerAttribution(rawText: string): string {
  return rawText.replace(/\s*\*[^*\n]+\*\s*<@[^>]+>\s*$/, "").trimEnd();
}
