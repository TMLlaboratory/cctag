import {
  buildPromptWithAttachments,
  countImages,
  isOutboundAttachable,
  outboxAdditions,
  outboxDir,
  readOutboundAttachments,
  saveIncomingFiles,
  snapshotOutbox,
  WrittenFileTracker,
  type AttachmentLimits,
  type DirSnapshot,
  type IncomingFile,
  type SavedAttachment,
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
  /** Files the agent wrote during the turn — confirmed writes only. */
  writes: WrittenFileTracker;
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

export interface TurnEngineOptions {
  turnTimeoutMs: number;
  pollIntervalMs: number;
  /**
   * Held by reference, not copied: in Hub–Spoke mode the Spoke narrows
   * `maxFileBytes` to the Hub's own cap once registration reports it, and every
   * holder of this object has to see that narrowing (see spoke/index.ts).
   */
  limits: AttachmentLimits;
}

export interface StartTurnOptions {
  /** Files attached to the triggering Slack message. Downloaded inside
   *  startTurn so the transfer happens under the pane reservation. */
  files?: IncomingFile[];
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
  /** The watcher's outbox snapshot, NOT a fresh one: re-baselining at adoption
   *  time would classify everything the agent produced before it blocked as
   *  pre-existing, and none of it would ever be posted. */
  outboxBaseline: DirSnapshot;
  /** Write tracking so far, handed over rather than restarted for the same
   *  reason — a write confirmed before the block still needs uploading. */
  writes: WrittenFileTracker;
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
    /** Read (never mutated) to tell whether this pane's cwd is shared with
     *  another paired thread — see uploadAttachments. */
    private readonly pairings: { list(): Pairing[] },
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

      // Downloading happens here, inside the reservation, not in the caller:
      // a several-megabyte transfer can take a minute, and doing it before the
      // pane is reserved lets a later short message start its turn first and
      // then reject this one as busy after all that work.
      const files = opts.files ?? [];
      const prepared = await this.prepareAttachments(pairing, files);
      if (prepared === null) return; // attachments unusable here; already explained in-thread
      if (files.length > 0 && prepared.saved.length === 0 && !text.trim()) return; // nothing left to send
      // A bare attachment with no words still has to say *something*, or the
      // agent gets a prompt that is only a file path.
      const promptText = prepared.saved.length
        ? buildPromptWithAttachments(text.trim() || "添付されたファイルを確認してください。", prepared.saved)
        : text;

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
        writes: new WrittenFileTracker(),
        toolCounts: {},
        statusHandle,
        lastStatusUpdateAt: 0,
        startedAt: Date.now(),
        abort: new AbortController(),
        currentPromptId: 0,
      };
      this.turns.set(paneId, state);

      const normalized = promptText
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
        // Retrying needs a stronger precondition than "the pane looks idle".
        // A short turn can finish between two polls, and by then whoever is at
        // the keyboard may have started typing the next prompt — a blind Enter
        // would submit *their* draft. The transcript growing past the
        // pre-submit offset means our prompt did land (Claude Code appends the
        // user message on submit), so that's the signal to stop. Without a
        // located transcript there's nothing to check against, so fall back to
        // the single conservative retry this had before.
        const canVerify = tPath !== "";
        const retries = prepared.imageCount > 0 && canVerify ? SUBMIT_RETRIES_WITH_IMAGES : 1;
        for (let i = 0; i < retries; i++) {
          await sleep(this.opts.pollIntervalMs);
          if (canVerify && transcriptSizeSafe(tPath) > offset) break; // submitted
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
   * Downloads the message's attachments and works out how the prompt should
   * read. Returns null when there's nothing left worth sending (every file
   * rejected and no text to fall back on), having already explained why in the
   * thread.
   */
  private async prepareAttachments(
    pairing: Pairing,
    files: IncomingFile[],
  ): Promise<{ saved: SavedAttachment[]; imageCount: number } | null> {
    if (files.length === 0) return { saved: [], imageCount: 0 };

    const channel = pairing.channel;
    const threadTs = pairing.threadTs ?? "";
    const fetcher = this.notifier.fetchIncomingFile?.bind(this.notifier);
    if (!fetcher) {
      await this.notifier.postReply(channel, threadTs, "⚠️ このモードでは添付ファイルを受け取れません。");
      return null;
    }

    // A Hub older than attachment support answers "no handler for fetch_file"
    // for every file. Left to saveIncomingFiles that reads as N separate
    // "couldn't download" lines, which points at the wrong thing entirely.
    let unsupported = false;
    const { saved, skipped } = await saveIncomingFiles(
      files,
      async (f) => {
        try {
          return await fetcher(f);
        } catch (err) {
          if (!isUnsupportedByRemote(err)) throw err;
          unsupported = true;
          return null;
        }
      },
      this.opts.limits,
    );

    if (unsupported) {
      await this.notifier.postReply(channel, threadTs, "⚠️ Hubが添付ファイルに未対応です（Hub側の更新が必要です）。");
    } else if (skipped.length > 0) {
      await this.notifier.postReply(channel, threadTs, `⚠️ 添付をスキップしました:\n${skipped.map((s) => `• ${s}`).join("\n")}`);
    }

    return { saved, imageCount: countImages(saved) };
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
        outboxBaseline: handoff.outboxBaseline,
        writes: handoff.writes,
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
        const output = state.driver.extractTurnOutput(records);
        state.collected.push(...output.texts);
        for (const name of output.toolNames) {
          state.toolCounts[name] = (state.toolCounts[name] ?? 0) + 1;
        }
        state.writes.ingest(output);
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
    // Removing the TurnState is what makes the pane look free again, but this
    // method still has to scan the outbox and read the files it finds. A turn
    // starting in that window would write its own artifacts into the same
    // directory and get them attributed to (and posted for) this one — so keep
    // the pane busy until the uploads are done.
    this.externallyBusy.add(paneId);
    this.turns.delete(paneId);
    try {
      await this.reportTurnResult(paneId, state, warning);
    } finally {
      this.externallyBusy.delete(paneId);
    }
  }

  private async reportTurnResult(paneId: string, state: TurnState, warning?: string): Promise<void> {
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
    await this.uploadAttachments(state.pairing, state.cwd, {
      outboxBaseline: state.outboxBaseline,
      writtenPaths: state.writes.paths(),
    });
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
  async uploadOutboxAdditions(
    pairing: Pairing,
    cwd: string,
    baseline: DirSnapshot,
    writtenPaths: string[] = [],
  ): Promise<DirSnapshot> {
    await this.uploadAttachments(pairing, cwd, { outboxBaseline: baseline, writtenPaths });
    return snapshotOutbox(cwd);
  }

  /**
   * Whether `.cctag/outbox` under this cwd can be attributed to one thread.
   *
   * The directory is keyed by cwd, so two panes opened on the same repository
   * and paired to different threads see each other's files as their own new
   * additions and would each post the other's artifacts. herdr reports every
   * pane's live cwd in one call, so the collision is detectable — and refusing
   * the shared directory (files stay on disk) beats sending a thread something
   * that was never meant for it. Transcript-detected writes are unaffected:
   * those come from this turn's own transcript, so they're never ambiguous.
   */
  private async outboxOwnership(pairing: Pairing, cwd: string): Promise<{ sole: true } | { sole: false; reason: string }> {
    const agents = await this.herdr.agentList().catch(() => null);
    if (!agents) {
      // Ownership can't be established, so it can't be assumed either.
      return { sole: false, reason: "herdrのインスタンス一覧を取得できず、宛先スレッドを確認できませんでした" };
    }
    const cwdByPane = new Map(agents.map((a) => [a.paneId, a.cwd]));
    const sharing = this.pairings.list().filter((p) => p.key !== pairing.key && cwdByPane.get(p.paneId) === cwd);
    if (sharing.length === 0) return { sole: true };
    return { sole: false, reason: "同じディレクトリに接続されたスレッドが他にもあり、どのスレッド宛てか判別できません" };
  }

  private async uploadAttachments(
    pairing: Pairing,
    cwd: string,
    sources: { outboxBaseline: DirSnapshot; writtenPaths: string[] },
  ): Promise<void> {
    const upload = this.notifier.uploadFile?.bind(this.notifier);
    if (!upload) return;

    const threadTs = pairing.threadTs ?? "";
    const fromOutbox = outboxAdditions(cwd, sources.outboxBaseline);
    const fromTranscript = sources.writtenPaths.filter(isOutboundAttachable);

    let candidates = fromTranscript;
    if (fromOutbox.length > 0) {
      const ownership = await this.outboxOwnership(pairing, cwd);
      if (ownership.sole) {
        candidates = [...fromOutbox, ...fromTranscript];
      } else {
        await this.notifier
          .postReply(
            pairing.channel,
            threadTs,
            `⚠️ \`.cctag/outbox/\` の自動添付を見送りました（${ownership.reason}）。` +
              `ファイルはそのまま残っています: ${outboxDir(cwd)}`,
          )
          .catch(() => {});
      }
    }
    if (candidates.length === 0) return;

    const { files, skipped } = readOutboundAttachments(candidates, this.opts.limits, cwd);
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
