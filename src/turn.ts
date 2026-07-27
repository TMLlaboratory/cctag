import {
  isOutboundAttachable,
  outboxAdditions,
  readOutboundAttachments,
  snapshotOutbox,
  type AttachmentLimits,
  type DirSnapshot,
} from "./attachments.js";
import type { HerdrClient } from "./herdr/client.js";
import type { Pairing } from "./pairing.js";
import { isUnsupportedByRemote, type MessageHandle, type Notifier } from "./notifier.js";
import { readNewRecords, transcriptSizeSafe } from "./agents/transcript.js";
import { driverFor, type AgentDriver, type AskUserQuestionPaneInfo } from "./agents/driver.js";
import { chunkForSlack, markdownToMrkdwn } from "./slack/mrkdwn.js";
import {
  askUserQuestionAnsweredText,
  askUserQuestionBlocks,
  doneStatusText,
  permissionBlocks,
  permissionParseFailureBlocks,
} from "./slack/blocks.js";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type TurnPhase = "running" | "awaiting-question" | "awaiting-permission";

interface TurnState {
  phase: TurnPhase;
  pairing: Pairing;
  requesterUserId: string;
  driver: AgentDriver;
  paneId: string;
  /** Live cwd of the pane, read at turn start — the outbox lives under it. */
  cwd: string;
  sessionId: string;
  transcriptPath: string;
  offset: number;
  collected: string[];
  /** `<cwd>/.cctag/outbox` as it looked when the turn began, so only what this
   *  turn put there gets uploaded. */
  outboxBaseline: DirSnapshot;
  /** Attachable files the agent wrote during the turn, per its transcript. */
  writtenPaths: Set<string>;
  toolCounts: Record<string, number>;
  statusHandle: MessageHandle;
  lastStatusUpdateAt: number;
  startedAt: number;
  abort: AbortController;
  // AskUserQuestion / permission prompts are read off the pane, not the
  // transcript — see agents/claude/prompts.ts for why. Each newly-posted
  // prompt gets a fresh id so stale button clicks (from an already-resolved
  // or already-superseded prompt) can be rejected.
  currentPromptId: number;
  promptHandle?: MessageHandle;
  pendingQuestionInfo?: AskUserQuestionPaneInfo;
  // Set when the current awaiting-permission prompt is Claude Code's
  // ExitPlanMode approval, which uniquely offers a "Tell Claude what to
  // change" free-text option — recorded so a plain thread reply can be
  // routed to it (refine the plan, stay in plan mode) instead of being
  // ignored the way free-text is for ordinary permission menus.
  planFeedbackOptionNum?: number;
}

export interface TurnEngineOptions extends AttachmentLimits {
  turnTimeoutMs: number;
  pollIntervalMs: number;
}

export interface StartTurnOptions {
  /** How many of the prompt's attachments are images. Non-zero switches the
   *  submit to the retry loop below — see SUBMIT_RETRIES_WITH_IMAGES. */
  imageCount?: number;
}

/**
 * How many times to re-send Enter when the prompt carried image attachments.
 *
 * Claude Code converts an image path in the input box into a real attachment
 * asynchronously, and the Enter that `agent prompt` sequences server-side is
 * swallowed while that runs — verified empirically: a prompt with a 2.8MB PNG
 * sat unsent in the box (agent still `idle`) until a later Enter, while the
 * same prompt carrying only non-image paths submitted immediately. Conversion
 * finished between 500ms and 1000ms in that measurement, but it scales with
 * file size and count, so this retries across several poll intervals instead
 * of assuming one is enough. Each extra Enter is a no-op once the box is
 * empty, which is why over-retrying is safe and under-retrying is not.
 */
const SUBMIT_RETRIES_WITH_IMAGES = 6;

export type AnswerResult = { ok: true } | { ok: false; reason: "not-pending" };

/** Transcript-tracking state BackgroundWatcher had already collected for a
 * pairing before it noticed the terminal was blocked — handed over so
 * adoptBlockedTerminal() doesn't lose or re-read anything. */
export interface BlockedTerminalHandoff {
  driver: AgentDriver;
  sessionId: string;
  transcriptPath: string;
  offset: number;
  collected: string[];
  paneId: string;
  /** Live pane cwd — the adopted turn needs it to find the outbox. */
  cwd: string;
}

export class TurnEngine {
  // Keyed by paneId — herdr's stable, restart-durable identity for a pane
  // (see pairing.ts's Pairing.paneId doc). Not terminal_id: herdr 0.7.5+
  // rejects terminal_id as an agent-command target, and paneId also survives
  // the CLI inside the pane restarting, which terminal_id would not.
  private turns = new Map<string, TurnState>();
  // Panes busy for a reason other than an active turn (e.g. commands.ts
  // running a /model or /plan TUI command) — kept separate from `turns` so
  // isBusy() covers both, and the BackgroundWatcher doesn't try to watch the
  // same instance a non-turn command is currently driving.
  private externallyBusy = new Set<string>();
  // Panes in the middle of startTurn()'s async setup, before a TurnState
  // exists in `turns` yet — closes the race where two concurrent calls for
  // the same pane could both pass the busy check.
  private reserving = new Set<string>();

  constructor(
    private readonly herdr: HerdrClient,
    private readonly notifier: Notifier,
    private readonly opts: TurnEngineOptions,
  ) {}

  isBusy(paneId: string): boolean {
    return this.turns.has(paneId) || this.externallyBusy.has(paneId) || this.reserving.has(paneId);
  }

  markBusy(paneId: string): void {
    this.externallyBusy.add(paneId);
  }

  clearBusy(paneId: string): void {
    this.externallyBusy.delete(paneId);
  }

  async abortTurn(paneId: string): Promise<void> {
    const state = this.turns.get(paneId);
    if (!state) return;
    state.abort.abort();
    this.turns.delete(paneId);
  }

  async startTurn(pairing: Pairing, requesterUserId: string, text: string, opts: StartTurnOptions = {}): Promise<void> {
    const paneId = pairing.paneId;
    // Reserve the slot synchronously, before any `await` — otherwise two
    // concurrent calls for the same pane (e.g. a duplicate Slack event)
    // can both pass the busy check before either inserts into `turns`,
    // leaving one turn's state silently overwritten and untracked.
    if (this.isBusy(paneId)) {
      throw new Error("busy");
    }
    this.reserving.add(paneId);

    try {
      const agent = await this.herdr.agentGet(paneId);
      if (!agent) {
        throw new Error("agent-not-found");
      }
      const driver = driverFor(agent.agent);

      const sessionId = agent.sessionId ?? "";
      const tPath = driver.locateTranscript(agent.cwd, agent.sessionId) ?? "";
      const offset = tPath ? transcriptSizeSafe(tPath) : 0;

      const statusHandle = await this.notifier.postMessage(pairing.channel, pairing.threadTs ?? "", "⚙️ 実行中…");

      const state: TurnState = {
        phase: "running",
        pairing,
        requesterUserId,
        driver,
        paneId: agent.paneId,
        cwd: agent.cwd,
        sessionId,
        transcriptPath: tPath,
        offset,
        collected: [],
        outboxBaseline: snapshotOutbox(agent.cwd),
        writtenPaths: new Set(),
        toolCounts: {},
        statusHandle,
        lastStatusUpdateAt: 0,
        startedAt: Date.now(),
        abort: new AbortController(),
        currentPromptId: 0,
      };
      this.turns.set(paneId, state);

      const normalized = text
        .replace(/<@[^>|]+(\|[^>]+)?>/g, "")
        .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "$2 ($1)")
        .replace(/<(https?:\/\/[^>]+)>/g, "$1")
        .trim();

      try {
        // Atomic submit (text + Enter, server-side) — NOT send-text then a
        // separate Enter. The two-call version raced Claude Code's paste
        // coalescing: an Enter arriving before the injected text settled got
        // absorbed as a newline, leaving the message unsent in the box until
        // the next turn flushed it. agent prompt sequences both itself... but
        // herdr 0.7.5 has been observed reporting agent.prompt as `ok` in ~2ms
        // while the pane stays idle and nothing actually lands (confirmed via
        // herdr's own server log against a real failure) — a herdr-internal
        // timing issue this call can't detect on its own. Guard against it: if
        // the pane is still idle after one poll interval, resend a bare Enter.
        // Harmless no-op if the box really is empty (nothing to submit); if
        // our text is sitting there unsent, this flushes it without a retry
        // loop mis-firing on a genuinely-instant reply (those move to
        // "working" at some point before settling, so the *resting* states —
        // idle or done, same pair pollLoop's own finalize check treats as
        // settled — are what "never even started" looks like here).
        //
        // Image attachments make this the normal case rather than the rare one,
        // and one retry is no longer enough — see SUBMIT_RETRIES_WITH_IMAGES.
        await this.herdr.agentPrompt(paneId, normalized);
        const retries = (opts.imageCount ?? 0) > 0 ? SUBMIT_RETRIES_WITH_IMAGES : 1;
        for (let i = 0; i < retries; i++) {
          await sleep(this.opts.pollIntervalMs);
          const recheck = await this.herdr.agentGet(paneId).catch(() => null);
          if (!recheck || (recheck.agentStatus !== "idle" && recheck.agentStatus !== "done")) break;
          await this.herdr.paneSendKeys(paneId, "Enter");
        }
      } catch (err) {
        // Input injection failed after the state was already registered —
        // roll it back so the terminal doesn't stay stuck "busy" forever.
        this.turns.delete(paneId);
        await statusHandle.update("❌ 開始に失敗しました").catch(() => {});
        throw err;
      }

      void this.pollLoop(paneId).catch((err) => {
        console.error(`[turn ${paneId}] poll loop crashed:`, err);
        this.turns.delete(paneId);
      });
    } finally {
      this.reserving.delete(paneId);
    }
  }

  /**
   * BackgroundWatcher calls this when it notices a paired terminal has gone
   * `blocked` with no active Slack-initiated turn running (i.e. work started
   * directly at the terminal just hit an AskUserQuestion or permission
   * prompt). Registering a TurnState and running the same pollLoop() a
   * normal turn uses means the existing AskUserQuestion/permission button
   * flow — and answering it from Slack — works identically whether the turn
   * was Slack-initiated or discovered mid-flight; no input is sent, since
   * the terminal is already sitting at the prompt.
   */
  async adoptBlockedTerminal(pairing: Pairing, handoff: BlockedTerminalHandoff): Promise<void> {
    const paneId = pairing.paneId;
    // Same reservation as startTurn() — a Slack-initiated turn could start
    // for this pane in the window between the watcher's isBusy() check
    // and this method actually registering a TurnState.
    if (this.isBusy(paneId)) return;
    this.reserving.add(paneId);

    try {
      const statusHandle = await this.notifier.postMessage(
        pairing.channel,
        pairing.threadTs ?? "",
        "🖥️ ターミナル側で入力待ちを検出しました…",
      );

      const state: TurnState = {
        phase: "running",
        pairing,
        requesterUserId: pairing.pairedBy,
        driver: handoff.driver,
        paneId: handoff.paneId,
        cwd: handoff.cwd,
        sessionId: handoff.sessionId,
        transcriptPath: handoff.transcriptPath,
        offset: handoff.offset,
        collected: [...handoff.collected],
        outboxBaseline: snapshotOutbox(handoff.cwd),
        writtenPaths: new Set(),
        toolCounts: {},
        statusHandle,
        lastStatusUpdateAt: 0,
        startedAt: Date.now(),
        abort: new AbortController(),
        currentPromptId: 0,
      };
      this.turns.set(paneId, state);

      void this.pollLoop(paneId).catch((err) => {
        console.error(`[turn ${paneId}] poll loop crashed:`, err);
        this.turns.delete(paneId);
      });
    } finally {
      this.reserving.delete(paneId);
    }
  }

  async answerQuestionButton(paneId: string, promptId: number, optionIndex: number): Promise<AnswerResult> {
    const state = this.turns.get(paneId);
    if (!state || state.phase !== "awaiting-question" || state.currentPromptId !== promptId || !state.pendingQuestionInfo) {
      return { ok: false, reason: "not-pending" };
    }
    const info = state.pendingQuestionInfo;
    const label = info.options[optionIndex]?.label ?? String(optionIndex + 1);

    await state.driver.answerOption(this.herdr, state.paneId, String(optionIndex + 1));
    await state.promptHandle?.update(askUserQuestionAnsweredText(info.header, label), []).catch(() => {});
    state.promptHandle = undefined;
    state.pendingQuestionInfo = undefined;
    state.phase = "running";
    return { ok: true };
  }

  async answerQuestionFreeText(paneId: string, freeText: string): Promise<AnswerResult> {
    const state = this.turns.get(paneId);
    if (!state || state.phase !== "awaiting-question" || !state.pendingQuestionInfo) {
      return { ok: false, reason: "not-pending" };
    }
    const info = state.pendingQuestionInfo;
    if (!state.driver.answerQuestionFreeText) return { ok: false, reason: "not-pending" };

    await state.driver.answerQuestionFreeText(this.herdr, state.paneId, info, freeText);

    await state.promptHandle?.update(askUserQuestionAnsweredText(info.header, freeText), []).catch(() => {});
    state.promptHandle = undefined;
    state.pendingQuestionInfo = undefined;
    state.phase = "running";
    return { ok: true };
  }

  async answerPermissionButton(paneId: string, promptId: number, num: string): Promise<AnswerResult> {
    const state = this.turns.get(paneId);
    if (!state || state.phase !== "awaiting-permission" || state.currentPromptId !== promptId) {
      return { ok: false, reason: "not-pending" };
    }
    await state.driver.answerOption(this.herdr, state.paneId, num);
    await state.promptHandle?.update(`→ ${num} を送信しました`, []).catch(() => {});
    state.promptHandle = undefined;
    state.planFeedbackOptionNum = undefined;
    state.phase = "running";
    return { ok: true };
  }

  /**
   * Free-text reply to an ExitPlanMode approval prompt: routes the text into
   * Claude Code's "Tell Claude what to change" option (verified mechanics:
   * send the option's digit to move the cursor there, type the feedback —
   * which replaces the option's placeholder label inline — then Enter, which
   * refines the plan and stays in plan mode). Only valid while the current
   * awaiting-permission prompt actually offered that option.
   */
  async answerPlanFeedback(paneId: string, freeText: string): Promise<AnswerResult> {
    const state = this.turns.get(paneId);
    if (!state || state.phase !== "awaiting-permission" || state.planFeedbackOptionNum === undefined) {
      return { ok: false, reason: "not-pending" };
    }
    if (!state.driver.answerPlanFeedback) return { ok: false, reason: "not-pending" };
    await state.driver.answerPlanFeedback(this.herdr, state.paneId, state.planFeedbackOptionNum, freeText);

    await state.promptHandle?.update(`→ 修正を依頼しました: ${freeText}`, []).catch(() => {});
    state.promptHandle = undefined;
    state.planFeedbackOptionNum = undefined;
    state.phase = "running";
    return { ok: true };
  }

  private async pollLoop(paneId: string): Promise<void> {
    const state = this.turns.get(paneId);
    if (!state) return;

    while (!state.abort.signal.aborted) {
      const interval = state.phase === "running" ? this.opts.pollIntervalMs : Math.max(this.opts.pollIntervalMs, 5_000);
      await sleep(interval);
      // Re-check: this loop's turn may have been aborted (and a new one
      // started for the same pane) while we were asleep. finalize()
      // looks up state by paneId, not by this closure's object identity,
      // so a stale loop reaching it after abort could delete/finalize a
      // different, newly-started turn.
      if (state.abort.signal.aborted) return;

      const agent = await this.herdr.agentGet(paneId).catch(() => null);
      if (!agent) {
        await this.finalize(paneId, "⚠️ インスタンスが終了しました（部分的な出力のみ）");
        return;
      }

      if (agent.sessionId && agent.sessionId !== state.sessionId) {
        state.sessionId = agent.sessionId;
        state.transcriptPath = state.driver.locateTranscript(agent.cwd, agent.sessionId) ?? "";
        state.offset = 0;
      }

      if (state.transcriptPath) {
        const { records, newOffset } = await readNewRecords(state.transcriptPath, state.offset);
        state.offset = newOffset;
        const { texts, toolNames, attachmentPaths } = state.driver.extractTurnOutput(records);
        state.collected.push(...texts);
        for (const name of toolNames) {
          state.toolCounts[name] = (state.toolCounts[name] ?? 0) + 1;
        }
        for (const p of attachmentPaths ?? []) state.writtenPaths.add(p);
      }

      if (state.phase === "running") {
        const now = Date.now();
        if (now - state.lastStatusUpdateAt > 3_000) {
          state.lastStatusUpdateAt = now;
          const lastTool = Object.keys(state.toolCounts).pop();
          const elapsed = Math.round((now - state.startedAt) / 1000);
          const suffix = lastTool ? ` — 🔧 ${lastTool}` : "";
          await state.statusHandle.update(`⚙️ 実行中… (${elapsed}s)${suffix}`).catch(() => {});
        }
      }

      // Applied before the `blocked` branch's `continue` below — otherwise an
      // unanswered prompt (nobody at the keyboard, nobody clicking the Slack
      // button) would keep the terminal "busy" forever, since blocked never
      // reaches the timeout check further down.
      if (Date.now() - state.startedAt > this.opts.turnTimeoutMs) {
        await this.finalize(paneId, "⚠️ タイムアウトしました（エージェントはまだ動作中の可能性があります）");
        return;
      }

      if (agent.agentStatus === "blocked") {
        if (state.phase === "running") {
          // A NEW prompt appeared (either the first one this turn, or the
          // next one in a multi-question flow — each is independently
          // parsed off the pane; see prompts.ts).
          const paneText = await this.herdr.paneRead(state.paneId, { source: state.driver.paneReadSource, lines: 60 });
          const prompt = state.driver.parseBlockedPane(paneText);
          state.currentPromptId += 1;
          if (prompt.kind === "question") {
            const aq = prompt.info;
            state.pendingQuestionInfo = aq;
            state.promptHandle = await this.notifier.postMessage(
              state.pairing.channel,
              state.pairing.threadTs ?? "",
              `❓ ${aq.header}: ${aq.question}`,
              askUserQuestionBlocks(paneId, state.currentPromptId, aq),
            );
            state.phase = "awaiting-question";
          } else {
            const { menu, isPlanPrompt, planFeedbackOptionNum: feedbackNum } = prompt;
            state.planFeedbackOptionNum = feedbackNum;

            if (isPlanPrompt && this.notifier.uploadTextFile) {
              await this.attachPlanFile(state, paneText).catch((err) =>
                console.error(`[turn ${paneId}] plan file attach failed:`, err),
              );
            }

            // Drop the "Tell Claude what to change" option from the buttons:
            // its digit only moves the cursor, it doesn't confirm (it expects
            // typed feedback next), so a button for it would be a dead end.
            // That path is handled by a free-text thread reply instead
            // (answerPlanFeedback), which the header points the user to.
            const buttonMenu =
              menu && feedbackNum !== undefined
                ? { ...menu, choices: menu.choices.filter((c) => c.num !== String(feedbackNum)) }
                : menu;

            const header = isPlanPrompt
              ? "📋 プランが提示されました。ボタンで承認するか、修正内容をこのスレッドに返信してください。"
              : "⚠️ 許可リクエスト";
            state.promptHandle = await this.notifier.postMessage(
              state.pairing.channel,
              state.pairing.threadTs ?? "",
              header,
              buttonMenu
                ? permissionBlocks(paneId, state.currentPromptId, buttonMenu, isPlanPrompt ? header : undefined)
                : permissionParseFailureBlocks(paneId, state.currentPromptId, paneText),
            );
            state.phase = "awaiting-permission";
          }
        }
        // else: already showing a prompt for this blocked state — keep waiting.
        continue;
      }

      if (state.phase !== "running") {
        // Was awaiting an answer, and the terminal is no longer blocked —
        // resolved, either by our own button/free-text (which already
        // cleared promptHandle) or directly at the terminal keyboard.
        if (state.promptHandle) {
          await state.promptHandle.update("（ターミナル側で回答済み）", []).catch(() => {});
          state.promptHandle = undefined;
        }
        state.pendingQuestionInfo = undefined;
        state.planFeedbackOptionNum = undefined;
        state.phase = "running";
      }

      if (agent.agentStatus === "idle" || agent.agentStatus === "done") {
        await this.finalize(paneId);
        return;
      }
    }
  }

  private async finalize(paneId: string, warning?: string): Promise<void> {
    const state = this.turns.get(paneId);
    if (!state) return;
    this.turns.delete(paneId);

    const elapsed = Math.round((Date.now() - state.startedAt) / 1000);
    const text = state.collected.join("\n\n").trim();

    if (text) {
      const mrkdwn = markdownToMrkdwn(text);
      for (const chunk of chunkForSlack(mrkdwn)) {
        await this.notifier.postReply(state.pairing.channel, state.pairing.threadTs ?? "", chunk);
      }
    }
    // No text collected and the transcript was never located at all (as
    // opposed to located-but-genuinely-empty) — almost always means herdr
    // couldn't report a sessionId and the driver's cwd-based fallback also
    // came up empty (e.g. no transcript file exists yet for this cwd), not
    // that the agent replied with nothing. Surface it distinctly so this
    // doesn't get misread as a normal silent completion.
    if (!text && !warning && !state.transcriptPath) {
      warning = "⚠️ transcriptが見つからず、応答テキストを読み取れませんでした（herdrがsessionIdを報告できていない可能性があります）。";
    }
    if (warning) {
      await this.notifier.postReply(state.pairing.channel, state.pairing.threadTs ?? "", warning);
    }
    const label = text ? doneStatusText(elapsed, state.toolCounts) : `✅ 完了 (${elapsed}s)（テキスト応答なし）`;
    await state.statusHandle.update(label).catch(() => {});
    // After the status update, not before: uploading several MB can take a
    // while, and the status line is an already-posted message being edited in
    // place, so settling it early doesn't reorder anything in the thread.
    await this.attachOutboundFiles(state).catch((err) =>
      console.error(`[turn ${paneId}] outbound attach failed:`, err),
    );
  }

  /**
   * Uploads files the turn produced that a Slack reader can't get from the
   * text: anything the agent dropped in `<cwd>/.cctag/outbox` (an explicit
   * "send this", so any file type goes), plus media/PDF files its transcript
   * shows it writing (which catches the common case without the agent needing
   * to know cctag exists).
   */
  private async attachOutboundFiles(state: TurnState): Promise<void> {
    await this.uploadAttachments(state.pairing, state.cwd, [
      ...outboxAdditions(state.cwd, state.outboxBaseline),
      ...[...state.writtenPaths].filter(isOutboundAttachable),
    ]);
  }

  /**
   * The same outbox upload for a pairing with *no* active turn — work started
   * at the terminal that never blocked is reported by BackgroundWatcher, not by
   * a TurnState, and would otherwise post its text to the thread while silently
   * dropping the chart it just rendered. Lives here rather than in the watcher
   * so the notifier and the size caps stay in one place (same reasoning as
   * adoptBlockedTerminal).
   *
   * Returns the outbox snapshot to keep as the next baseline, so a settled turn
   * that uploaded nothing new doesn't re-upload on the following tick.
   */
  async uploadOutboxAdditions(pairing: Pairing, cwd: string, baseline: DirSnapshot): Promise<DirSnapshot> {
    await this.uploadAttachments(pairing, cwd, outboxAdditions(cwd, baseline));
    return snapshotOutbox(cwd);
  }

  private async uploadAttachments(pairing: Pairing, cwd: string, candidates: string[]): Promise<void> {
    const upload = this.notifier.uploadFile?.bind(this.notifier);
    if (!upload || candidates.length === 0) return;

    const threadTs = pairing.threadTs ?? "";
    const { files, skipped } = readOutboundAttachments(candidates, this.opts, cwd);
    for (const f of files) {
      try {
        await upload(pairing.channel, threadTs, {
          contentB64: f.contentB64,
          filename: f.name,
          comment: `📎 ${f.name}`,
        });
      } catch (err) {
        // Hub and Spoke ship independently: a Hub without upload_file support
        // answers "no handler", which is worth saying out loud once rather than
        // failing silently every turn.
        const reason = isUnsupportedByRemote(err)
          ? "⚠️ Hubがファイル添付に未対応です（Hub側の更新が必要です）。"
          : `⚠️ ${f.name} の添付に失敗しました: ${err instanceof Error ? err.message : String(err)}`;
        await this.notifier.postReply(pairing.channel, threadTs, reason).catch(() => {});
        return; // every remaining file would fail the same way
      }
    }
    if (skipped.length > 0) {
      await this.notifier
        .postReply(pairing.channel, threadTs, `⚠️ 添付を省略しました:\n${skipped.map((s) => `• ${s}`).join("\n")}`)
        .catch(() => {});
    }
  }

  /**
   * Reads the plan markdown the driver wrote (Claude Code's ExitPlanMode)
   * and uploads it to the thread, so the full plan is available as a
   * downloadable file rather than only rendered (line-wrapped) in the pane.
   */
  private async attachPlanFile(state: TurnState, paneText: string): Promise<void> {
    if (!this.notifier.uploadTextFile) return;
    if (!state.driver.resolvePlanFile) return;
    const abs = state.driver.resolvePlanFile(paneText);
    if (!abs) return;
    const content = readFileSync(abs, "utf8");
    if (!content.trim()) return;
    await this.notifier.uploadTextFile(state.pairing.channel, state.pairing.threadTs ?? "", {
      content,
      filename: basename(abs),
      title: `${state.driver.displayName} のプラン`,
      comment: "📋 プラン全文（.md）",
    });
  }
}
