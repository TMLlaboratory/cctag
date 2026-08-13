import {
  buildPromptWithAttachments,
  countImages,
  outboxAdditions,
  outboxDir,
  readOutboundAttachments,
  saveIncomingFiles,
  snapshotOutbox,
  WrittenFileTracker,
  type AttachmentLimits,
  type DirSnapshot,
  type OutboundCandidate,
  type IncomingFile,
  type SavedAttachment,
} from "./attachments.js";
import type { HerdrClient } from "./herdr/client.js";
import type { AgentInfo } from "./herdr/types.js";
import { PaneLeaseRegistry, type PaneLease } from "./leases.js";
import type { Pairing } from "./pairing.js";
import { isUnsupportedByRemote, type MessageHandle, type Notifier } from "./notifier.js";
import { readNewRecords, transcriptSizeSafe } from "./agents/transcript.js";
import {
  driverFor,
  promptFingerprint,
  type AgentDriver,
  type AskUserQuestionPaneInfo,
  type BlockedPrompt,
} from "./agents/driver.js";
import { chunkForSlack, markdownToMrkdwn } from "./slack/mrkdwn.js";
import { postSegmented } from "./slack/post.js";
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

/**
 * Waits before the next poll, giving up as soon as the lease is cancelled.
 *
 * The wait is five seconds while a prompt is up, and the holder releases the pane
 * on its way out — so how fast it notices cancellation *is* how fast the pane
 * comes back.
 *
 * Deliberately not woken by an answer, though that would make the status line and
 * the result arrive sooner. Tried, and it re-posted the prompt that had just been
 * answered: the pane still reports `blocked` for a moment after the keystroke, and
 * a loop resuming inside that moment sees a blocked pane with a running turn and
 * treats it as a new prompt. The answer already posts its own status line, so the
 * only cost of waiting is a stale elapsed time.
 */
function waitBeforeNextPoll(state: TurnState, ms: number): Promise<void> {
  if (state.lease.signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      state.lease.signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    state.lease.signal.addEventListener("abort", done, { once: true });
  });
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
  /**
   * When to give up, as an absolute time rather than `startedAt + timeout`.
   *
   * The distinction matters because a blocked pane is waiting on a person, and
   * a person taking their time is not a stalled turn. Every poll that finds the
   * pane blocked pushes this forward, so the timeout only ever measures how
   * long the *agent* has gone without progress. Without that, an unanswered
   * prompt timed out on schedule, the turn ended, and BackgroundWatcher — which
   * adopts any blocked paired pane with no active turn — immediately re-adopted
   * it and posted the same prompt again, once per timeout window, forever.
   */
  deadlineAt: number;
  /**
   * Consecutive failures per herdr operation, each reset only by that same
   * operation succeeding.
   *
   * One shared counter did not work: agentGet runs first on every poll, so its
   * success reset the count before paneRead was even attempted. A pane whose
   * reads failed persistently therefore never got past "first failure", and —
   * being blocked — had its deadline pushed forward each time too, so the turn
   * held the pane forever while making no progress at all.
   */
  failures: { agentGet: number; paneRead: number };
  /** This turn's claim on the pane. Its signal is what the poll loop watches,
   *  so cancelling the lease stops the loop; released by finalize/abort. */
  lease: PaneLease;
  // AskUserQuestion / permission prompts are read off the pane, not the
  // transcript — see agents/claude/prompts.ts for why. Each newly-posted
  // prompt gets a fresh id so stale button clicks (from an already-resolved
  // or already-superseded prompt) can be rejected.
  currentPromptId: number;
  /** Identity of the prompt `promptHandle` is showing, so a different one
   *  appearing while the pane stays `blocked` is detectable. Null when the pane
   *  didn't parse — never compared in that case (see promptFingerprint). */
  promptFingerprint?: string | null;
  /**
   * Set synchronously the moment an answer is accepted, before any input is
   * sent, and cleared once the prompt is resolved or the attempt failed.
   *
   * The phase/prompt-id checks alone cannot serialize two answers: Slack buttons
   * can be clicked twice, and both deliveries pass those checks before either
   * reaches the state mutation that happens after `await`. Both then drive the
   * TUI — for Codex that is digit-plus-Enter twice, whose second copy can land
   * on whatever menu appeared next and confirm it.
   */
  answering?: boolean;
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

/**
 * How many herdr queries in a row may fail before a turn gives up on its pane.
 *
 * Each herdr call already has its own 15s timeout, so this tolerates roughly a
 * minute of herdr being unreachable — long enough to ride out a restart (the
 * Homebrew auto-update case that produced `protocol_mismatch` before) without
 * abandoning a turn whose agent is still working perfectly well.
 */
const HERDR_FAILURES_BEFORE_GIVING_UP = 3;

/**
 * How much of a blocked pane to read before parsing the prompt on it.
 *
 * Was 60, which is not enough: a question whose options carry previews draws the
 * preview in a box beside them, and a long preview pushes the option lines out
 * of the window entirely. Measured on a real dialog with a 12-line preview — at
 * 60 lines the option rows were absent and parsing returned nothing, at 80 they
 * were present. Previews are unbounded, so this leaves real headroom; a pane read
 * is cheap text, and both parsers now bind to the *last* dialog in the window so
 * a wider read cannot make them latch onto an older one.
 */
const BLOCKED_PANE_LINES = 200;

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
  // The single source of truth for "who has this pane". Replaced a trio of
  // Sets (turns + externallyBusy + reserving) behind one boolean isBusy():
  // that could say a pane was taken but not by whom, so a claim was always two
  // steps with awaits in between, and whichever holder finished first freed a
  // pane another was still driving. See leases.ts.
  private readonly leases = new PaneLeaseRegistry();

  constructor(
    private readonly herdr: HerdrClient,
    private readonly notifier: Notifier,
    private readonly opts: TurnEngineOptions,
    /** Read (never mutated) to tell whether this pane's cwd is shared with
     *  another paired thread — see uploadAttachments. */
    private readonly pairings: { list(): Pairing[] },
  ) {}

  isBusy(paneId: string): boolean {
    return this.leases.isHeld(paneId);
  }

  /**
   * Takes a pane for work that isn't a turn — a `/model` or `/mode` command
   * driving the TUI directly. The caller must release it in a `finally`, and
   * must re-check `cancelled` after anything it awaits.
   */
  acquire(paneId: string, reason: string): PaneLease | null {
    return this.leases.tryAcquire(paneId, reason);
  }

  /**
   * Stops whatever holds this pane: aborts a turn outright, and signals
   * cancellation to work that is still setting up so it abandons before driving
   * the pane. Used by `disconnect`, which previously could only reach a turn
   * that had already registered — a disconnect during startTurn's attachment
   * download left the pairing gone but the setup running, so it went on to send
   * the prompt and post a prompt into a thread that could no longer answer it,
   * holding the pane indefinitely.
   */
  cancelPane(paneId: string): void {
    // Signals only. Releasing here would hand the pane to the next caller while
    // the current holder is still driving it: a cancel during startTurn's submit
    // sequence would leave that sequence typing into a pane something else had
    // already claimed. Whoever holds it notices `cancelled` and releases in its
    // own finally — the registry is built around that (see leases.ts).
    this.leases.cancel(paneId);
  }

  /**
   * Abandons every in-flight turn. Called when this engine's notifier dies —
   * in Spoke mode the WebSocket to the Hub dropping — because a poll loop that
   * outlives its transport is worse than no loop at all: it can't deliver
   * anything, yet it keeps polling herdr, and the replacement engine built for
   * the new connection starts a *second* loop over the same panes. If a pane is
   * blocked, the new side then posts the prompt the old side still thinks it
   * owns. Returns how many turns were dropped, for the log line.
   */
  abortAll(): number {
    // Also signal-only, for the same reason. Each poll loop sees the abort on
    // its next tick, finalizes or returns, and releases on the way out.
    return this.leases.cancelAll();
  }

  async startTurn(pairing: Pairing, requesterUserId: string, text: string, opts: StartTurnOptions = {}): Promise<void> {
    const paneId = pairing.paneId;
    // Claimed synchronously, before any `await` — otherwise two concurrent
    // calls for the same pane (e.g. a duplicate Slack event) can both pass the
    // check before either registers, leaving one turn's state silently
    // overwritten and untracked.
    const lease = this.leases.tryAcquire(paneId, "turn");
    if (!lease) {
      throw new Error("busy");
    }
    let handedToPollLoop = false;

    try {
      const agent = await this.herdr.agentGet(paneId);
      if (!agent) {
        throw new Error("agent-not-found");
      }
      if (lease.cancelled) return;
      const driver = driverFor(agent.agent);

      // Downloading happens here, inside the reservation, not in the caller:
      // a several-megabyte transfer can take a minute, and doing it before the
      // pane is reserved lets a later short message start its turn first and
      // then reject this one as busy after all that work.
      const files = opts.files ?? [];
      const prepared = await this.prepareAttachments(pairing, files);
      // The longest await in the method by far, and the one `disconnect` is most
      // likely to land inside. Nothing has touched the pane yet, so abandoning
      // here is clean — whereas going on would prompt an agent whose thread no
      // longer exists to answer it.
      if (lease.cancelled) return;
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

      // A pane sitting at one of the agent's startup dialogs reports `idle`, so
      // nothing above this catches it, and submitting anyway is actively
      // harmful: the prompt text is swallowed by the menu and the Enter that
      // follows confirms whatever option is selected. Measured consequences of
      // that, both on Codex — the directory-trust dialog defaults to "yes, I
      // trust this", and the "update available" dialog defaults to *running*
      // `brew upgrade --cask codex`, which swapped the binary out from under a
      // live session. Either way no turn runs and no session file is written,
      // so the thread gets a warning about a transcript that never existed.
      //
      // Deliberately NOT auto-answered. One of these grants trust that guards
      // against prompt injection from untrusted directory contents, and the
      // other mutates the installed toolchain. Neither is cctag's call to make
      // because a Slack message arrived — they belong to whoever can see the
      // directory and the machine.
      //
      // Only checked when no transcript could be located, which is the
      // signature of a pane no turn has ever run in. Established panes skip the
      // extra pane read entirely, so this costs nothing on the hot path — and
      // it's what lets the detector be shape-based rather than a list of known
      // dialogs, since the only thing on a fresh pane's screen is startup UI.
      if (!tPath && driver.parseStartupPrompt) {
        const paneText = await this.herdr
          .paneRead(agent.paneId, { source: driver.paneReadSource, lines: 40 })
          .catch(() => "");
        const question = paneText ? driver.parseStartupPrompt(paneText) : null;
        if (question) {
          await this.notifier.postReply(
            pairing.channel,
            pairing.threadTs ?? "",
            `⚠️ ペインが起動時のダイアログで停止しています。ターミナルで応答してください。\n` +
              `> ${question}\n` +
              `cctagは代わりに答えません（信頼の付与やツールチェーンの更新を含むため、` +
              `ディレクトリと環境を確認できる人が判断すべき項目です）。応答後にもう一度送ってください。`,
          );
          return;
        }
      }

      if (lease.cancelled) return; // last exit before anything is posted or sent
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
        deadlineAt: Date.now() + this.opts.turnTimeoutMs,
        failures: { agentGet: 0, paneRead: 0 },
        lease,
        currentPromptId: 0,
      };
      this.turns.set(paneId, state);

      // Checked again after the post above: that await is where a disconnect is
      // most likely to land now that the earlier ones are covered, and what
      // follows sends the prompt to a live pane.
      if (lease.cancelled) {
        this.turns.delete(paneId);
        await statusHandle.update("（切断されました）").catch(() => {});
        return;
      }

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
          // A cancel landing mid-sequence must stop the keystrokes, not just the
          // poll loop afterwards: these Enters go to a live pane, and by now the
          // thread they belong to may already be disconnected.
          if (lease.cancelled) break;
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

      // Checked once more before handing over: a cancel arriving during the
      // submit sequence above must not leave a poll loop running for a thread
      // that has already been disconnected.
      if (lease.cancelled) {
        this.turns.delete(paneId);
        return;
      }

      handedToPollLoop = true;
      void this.pollLoop(state).catch((err) => {
        console.error(`[turn ${paneId}] poll loop crashed:`, err);
      });
    } finally {
      // The poll loop releases in its own finally from here on; every other exit
      // — cancelled, thrown, nothing to send — gives the pane back itself, or it
      // would stay busy for the life of the process.
      if (!handedToPollLoop) lease.release();
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
  async adoptBlockedTerminal(pairing: Pairing, handoff: BlockedTerminalHandoff): Promise<boolean> {
    const paneId = pairing.paneId;
    // Same claim as startTurn() — a Slack-initiated turn could start for this
    // pane in the window between the watcher's check and this method actually
    // registering a TurnState. Reported back so the watcher knows whether its
    // handoff was taken: it used to discard its collected output before finding
    // out, losing it when the adoption was refused.
    const lease = this.leases.tryAcquire(paneId, "adopted-terminal");
    if (!lease) return false;
    let handedToPollLoop = false;

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
        deadlineAt: Date.now() + this.opts.turnTimeoutMs,
        failures: { agentGet: 0, paneRead: 0 },
        lease,
        currentPromptId: 0,
      };
      this.turns.set(paneId, state);

      // Same check as startTurn: the status message above is an await, and a
      // cancel landing inside it would otherwise start a loop for a pane nobody
      // is listening to any more.
      if (lease.cancelled) {
        this.turns.delete(paneId);
        return false;
      }

      handedToPollLoop = true;
      void this.pollLoop(state).catch((err) => {
        console.error(`[turn ${paneId}] poll loop crashed:`, err);
      });
    } finally {
      if (!handedToPollLoop) lease.release();
    }
    return handedToPollLoop;
  }

  async answerQuestionButton(paneId: string, promptId: number, optionIndex: number): Promise<AnswerResult> {
    const state = this.turns.get(paneId);
    if (
      !state ||
      state.phase !== "awaiting-question" ||
      state.currentPromptId !== promptId ||
      !state.pendingQuestionInfo ||
      state.answering
    ) {
      return { ok: false, reason: "not-pending" };
    }
    const info = state.pendingQuestionInfo;
    const label = info.options[optionIndex]?.label ?? String(optionIndex + 1);

    state.answering = true; // claimed — see TurnState.answering
    try {
      const answer = state.driver.answerQuestionOption
        ? state.driver.answerQuestionOption(this.herdr, state.paneId, optionIndex + 1, info, state.lease.signal)
        : state.driver.answerOption(this.herdr, state.paneId, String(optionIndex + 1));
      await answer;
    } catch (err) {
      state.answering = false; // nothing was accepted; let the user try again
      throw err;
    }
    await state.promptHandle?.update(askUserQuestionAnsweredText(info.header, label), []).catch(() => {});
    this.markPromptResolved(state);
    await this.restartStatusLine(state);
    return { ok: true };
  }

  async answerQuestionFreeText(paneId: string, freeText: string): Promise<AnswerResult> {
    const state = this.turns.get(paneId);
    if (!state || state.phase !== "awaiting-question" || !state.pendingQuestionInfo || state.answering) {
      return { ok: false, reason: "not-pending" };
    }
    const info = state.pendingQuestionInfo;
    const answer = state.driver.answerQuestionFreeText;
    if (!answer) return { ok: false, reason: "not-pending" };

    state.answering = true;
    try {
      await answer(this.herdr, state.paneId, info, freeText);
    } catch (err) {
      state.answering = false;
      throw err;
    }
    await state.promptHandle?.update(askUserQuestionAnsweredText(info.header, freeText), []).catch(() => {});
    this.markPromptResolved(state);
    await this.restartStatusLine(state);
    return { ok: true };
  }

  async answerPermissionButton(paneId: string, promptId: number, num: string): Promise<AnswerResult> {
    const state = this.turns.get(paneId);
    if (!state || state.phase !== "awaiting-permission" || state.currentPromptId !== promptId || state.answering) {
      return { ok: false, reason: "not-pending" };
    }
    state.answering = true;
    try {
      await state.driver.answerOption(this.herdr, state.paneId, num);
    } catch (err) {
      state.answering = false;
      throw err;
    }
    await state.promptHandle?.update(`→ ${num} を送信しました`, []).catch(() => {});
    this.markPromptResolved(state);
    await this.restartStatusLine(state);
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
    if (
      !state ||
      state.phase !== "awaiting-permission" ||
      state.planFeedbackOptionNum === undefined ||
      state.answering
    ) {
      return { ok: false, reason: "not-pending" };
    }
    const answer = state.driver.answerPlanFeedback;
    if (!answer) return { ok: false, reason: "not-pending" };

    state.answering = true;
    try {
      await answer(this.herdr, state.paneId, state.planFeedbackOptionNum, freeText);
    } catch (err) {
      state.answering = false;
      throw err;
    }
    await state.promptHandle?.update(`→ 修正を依頼しました: ${freeText}`, []).catch(() => {});
    this.markPromptResolved(state);
    await this.restartStatusLine(state);
    return { ok: true };
  }

  /**
   * Posts a fresh status line and makes it the turn's.
   *
   * Answering from Slack left no visible sign that anything was happening: the
   * status line belongs to the message the turn opened with — for an adopted
   * terminal, "入力待ちを検出しました", posted before the prompt and by then well up
   * the thread — so the only feedback next to the button was the prompt text
   * changing. Reported from real use: the answer looked like it had gone nowhere,
   * the next message was sent, and it came back rejected as busy while the
   * terminal was in fact working.
   *
   * A new message costs one line per answer and puts the running state where the
   * click was. Best-effort: failing to post it must not fail the answer, which
   * has already reached the pane.
   */
  private async restartStatusLine(state: TurnState): Promise<void> {
    const handle = await this.notifier
      .postMessage(state.pairing.channel, state.pairing.threadTs ?? "", "⚙️ 実行中…")
      .catch(() => null);
    if (!handle) return;
    state.statusHandle = handle;
    // So the poll loop's next tick refreshes it with the elapsed time and tool
    // instead of waiting out its three-second throttle.
    state.lastStatusUpdateAt = 0;
  }

  /** Clears everything tied to the prompt just answered and hands the turn back
   *  to the poll loop. Shared by all four answer paths so none can forget a
   *  field — notably `answering`, which would otherwise wedge the turn. */
  private markPromptResolved(state: TurnState): void {
    state.promptHandle = undefined;
    state.promptFingerprint = undefined;
    state.pendingQuestionInfo = undefined;
    state.planFeedbackOptionNum = undefined;
    state.answering = false;
    state.phase = "running";
  }

  /**
   * Posts the prompt currently on the pane and moves the turn into the matching
   * awaiting-* phase. Called both for the first prompt of a blocked stretch and
   * for one that replaced it while the pane never left `blocked`, so it must not
   * assume anything about the phase it starts from.
   */
  private async postPrompt(
    state: TurnState,
    paneText: string,
    prompt: BlockedPrompt,
    fingerprint: string | null,
  ): Promise<void> {
    const paneId = state.paneId;
    state.currentPromptId += 1;
    state.promptFingerprint = fingerprint;
    state.answering = false;

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
      return;
    }

    const { menu, isPlanPrompt, planFeedbackOptionNum: feedbackNum } = prompt;
    state.planFeedbackOptionNum = feedbackNum;

    if (isPlanPrompt && this.notifier.uploadTextFile) {
      await this.attachPlanFile(state, paneText).catch((err) =>
        console.error(`[turn ${paneId}] plan file attach failed:`, err),
      );
    }

    // Drop the "Tell Claude what to change" option from the buttons: its digit
    // only moves the cursor, it doesn't confirm (it expects typed feedback
    // next), so a button for it would be a dead end. That path is handled by a
    // free-text thread reply instead (answerPlanFeedback), which the header
    // points the user to.
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

  private async pollLoop(state: TurnState): Promise<void> {
    const paneId = state.paneId;
    try {
      await this.poll(state);
    } finally {
      // Every exit returns the pane: cancelled, settled, timed out, thrown. This
      // used to be the caller's job via finalize() alone, which meant a loop that
      // returned on a cancelled signal — the ordinary disconnect path — left the
      // pane held for the life of the process.
      if (this.turns.get(paneId) === state) this.turns.delete(paneId);
      state.lease.release();
    }
  }

  private async poll(state: TurnState): Promise<void> {
    const paneId = state.paneId;
    while (!state.lease.signal.aborted) {
      const interval = state.phase === "running" ? this.opts.pollIntervalMs : Math.max(this.opts.pollIntervalMs, 5_000);
      await waitBeforeNextPoll(state, interval);
      // Re-check: this loop's turn may have been cancelled (and a new one
      // started for the same pane) while we were asleep. finalize()
      // looks up state by paneId, not by this closure's object identity,
      // so a stale loop reaching it after abort could delete/finalize a
      // different, newly-started turn.
      if (state.lease.signal.aborted) return;

      // `null` and a thrown error mean different things and must not be
      // conflated: agentGet() returns null only for herdr's own "no such pane"
      // answer, but throws for a command timeout, a spawn failure, or output it
      // can't parse. Treating the second as a dead pane ended live turns on a
      // transient hiccup — and, because finalize() releases the pane, handed it
      // to the watcher, which rebaselines and drops the rest of the output.
      let agent: AgentInfo | null;
      try {
        agent = await this.herdr.agentGet(paneId);
        state.failures.agentGet = 0;
      } catch (err) {
        state.failures.agentGet += 1;
        if (state.failures.agentGet <= HERDR_FAILURES_BEFORE_GIVING_UP) {
          console.error(
            `[turn ${paneId}] herdr query failed (${state.failures.agentGet}/${HERDR_FAILURES_BEFORE_GIVING_UP}), retrying:`,
            err instanceof Error ? err.message : err,
          );
          continue;
        }
        await this.finalize(state, "⚠️ herdrへの問い合わせが連続して失敗しました（部分的な出力のみ）");
        return;
      }
      if (!agent) {
        await this.finalize(state, "⚠️ インスタンスが終了しました（部分的な出力のみ）");
        return;
      }

      if (agent.sessionId && agent.sessionId !== state.sessionId) {
        state.sessionId = agent.sessionId;
        state.transcriptPath = state.driver.locateTranscript(agent.cwd, agent.sessionId) ?? "";
        state.offset = 0;
      } else if (!state.transcriptPath) {
        // Still no transcript (herdr may never report a sessionId at all —
        // e.g. its SessionStart hook is being blocked — so the branch above
        // never fires). Retry the driver's cwd-based fallback every poll:
        // the very first attempt (at turn start, in startTurn()) can miss if
        // Claude Code hasn't created the session's transcript file yet, and
        // without this retry that miss is permanent for the rest of the turn.
        const located = state.driver.locateTranscript(agent.cwd, agent.sessionId) ?? "";
        if (located) {
          state.transcriptPath = located;
          state.offset = 0;
        }
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

      // A blocked pane is waiting on a person, so the clock doesn't run. This
      // has to come *before* the check below rather than after: while a prompt
      // is up the loop sleeps on a 5s floor, so a deadline refreshed only after
      // the check would already have lapsed by the time the next poll reads it.
      const blocked = agent.agentStatus === "blocked";
      if (blocked) state.deadlineAt = Date.now() + this.opts.turnTimeoutMs;

      if (Date.now() > state.deadlineAt) {
        await this.finalize(state, "⚠️ タイムアウトしました（エージェントはまだ動作中の可能性があります）");
        return;
      }

      if (blocked) {
        // Staying busy for as long as the prompt is up is what stops
        // BackgroundWatcher from re-adopting the pane and posting the same
        // prompt again; and a pane sitting at a prompt is not one a new turn
        // could start on anyway — text sent to it would land in the dialog.
        // Tolerated the same way agentGet's failures are, and for a sharper
        // reason: an exception here used to escape the loop entirely, and the
        // crash handler released the pane — so a single herdr hiccup while a
        // prompt was up handed the pane to the watcher, which re-adopted it and
        // posted the same prompt again, losing the collected output on the way.
        // Ownership of a prompt already delivered to Slack must not turn on one
        // failed read.
        let paneText: string;
        try {
          paneText = await this.herdr.paneRead(state.paneId, {
            source: state.driver.paneReadSource,
            lines: BLOCKED_PANE_LINES,
          });
          state.failures.paneRead = 0;
        } catch (err) {
          state.failures.paneRead += 1;
          if (state.failures.paneRead <= HERDR_FAILURES_BEFORE_GIVING_UP) {
            console.error(
              `[turn ${paneId}] pane read failed (${state.failures.paneRead}/${HERDR_FAILURES_BEFORE_GIVING_UP}), retrying:`,
              err instanceof Error ? err.message : err,
            );
            continue;
          }
          await this.finalize(state, "⚠️ herdrへの問い合わせが連続して失敗しました（部分的な出力のみ）");
          return;
        }
        const prompt = state.driver.parseBlockedPane(paneText);
        const fingerprint = promptFingerprint(prompt);

        if (state.phase === "running") {
          // A NEW prompt appeared (either the first one this turn, or the
          // next one in a multi-question flow — each is independently
          // parsed off the pane; see prompts.ts).
          await this.postPrompt(state, paneText, prompt, fingerprint);
        } else if (fingerprint !== null && fingerprint !== state.promptFingerprint) {
          // Includes the case where the posted prompt had no identity at all.
          // What was posted for it is a raw screen dump with no usable buttons,
          // so replacing that with a prompt we *can* read is strictly better —
          // and it can only happen once, since the replacement has a fingerprint.
          // Requiring the old one to be non-null meant an unparseable prompt
          // permanently blinded this check: every prompt after it was invisible.
          // A DIFFERENT prompt is showing than the one posted, without the pane
          // ever leaving `blocked`: the pending one was answered at the keyboard
          // and the agent went straight into the next. Nothing else reports
          // that, so without this the thread would keep offering buttons for a
          // prompt that is gone and never show the one actually waiting.
          await state.promptHandle?.update("（ターミナル側で回答済み）", []).catch(() => {});
          state.pendingQuestionInfo = undefined;
          state.planFeedbackOptionNum = undefined;
          await this.postPrompt(state, paneText, prompt, fingerprint);
        }
        // else: still the same prompt we already posted — keep waiting.
        continue;
      }

      if (state.phase !== "running") {
        // Was awaiting an answer, and the terminal is no longer blocked —
        // resolved, either by our own button/free-text (which already
        // cleared promptHandle) or directly at the terminal keyboard.
        await state.promptHandle?.update("（ターミナル側で回答済み）", []).catch(() => {});
        this.markPromptResolved(state);
      }

      if (agent.agentStatus === "idle" || agent.agentStatus === "done") {
        await this.finalize(state);
        return;
      }
    }
  }

  private async finalize(state: TurnState, warning?: string): Promise<void> {
    const paneId = state.paneId;
    // By identity, never by pane id alone: a loop that outlived its turn would
    // otherwise finalize — and post the result of — whichever turn is registered
    // for the pane now.
    if (this.turns.get(paneId) !== state) return;
    // The TurnState goes now, but this method still has to scan the outbox and
    // read the files it finds. A turn starting in that window would write its own
    // artifacts into the same directory and get them attributed to (and posted
    // for) this one — so the lease is held across the uploads and only released
    // at the end. That used to need a second marker (externallyBusy) precisely
    // because "busy" and "has a TurnState" were the same thing; holding a lease
    // says it directly.
    this.turns.delete(paneId);
    try {
      await this.reportTurnResult(paneId, state, warning);
    } finally {
      state.lease.release();
    }
  }

  private async reportTurnResult(paneId: string, state: TurnState, warning?: string): Promise<void> {
    const elapsed = Math.round((Date.now() - state.startedAt) / 1000);
    const text = state.collected.join("\n\n").trim();

    if (text) {
      await postSegmented(this.notifier, state.pairing.channel, state.pairing.threadTs ?? "", text);
    }
    // No text collected and the transcript was never located at all (as
    // opposed to located-but-genuinely-empty) — almost always means herdr
    // couldn't report a sessionId and the driver's cwd-based fallback also
    // came up empty (e.g. no transcript file exists yet for this cwd), not
    // that the agent replied with nothing. Surface it distinctly so this
    // doesn't get misread as a normal silent completion.
    if (!text && !warning && !state.transcriptPath) {
      // The likely cause differs by agent, and naming the wrong one sends
      // whoever reads this down the wrong path. herdr does report a sessionId
      // for Claude Code (via its SessionStart hook), so its absence is worth
      // suspecting there. It never reports one for Codex — the cwd scan is the
      // normal route — so for Codex the answer is almost always that no turn
      // ever started in the pane, since Codex only writes its session file once
      // one does.
      warning =
        state.driver.kind === "codex"
          ? "⚠️ transcriptが見つからず、応答テキストを読み取れませんでした（ペインでターンが開始されなかった可能性があります。Codexはターンが走るまでセッションファイルを作りません）。"
          : "⚠️ transcriptが見つからず、応答テキストを読み取れませんでした（herdrがsessionIdを報告できていない可能性があります）。";
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
      confirmed: state.writes.paths(),
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
    confirmed: OutboundCandidate[] = [],
  ): Promise<DirSnapshot> {
    await this.uploadAttachments(pairing, cwd, { outboxBaseline: baseline, confirmed });
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
    sources: { outboxBaseline: DirSnapshot; confirmed: OutboundCandidate[] },
  ): Promise<void> {
    const upload = this.notifier.uploadFile?.bind(this.notifier);
    if (!upload) return;

    const threadTs = pairing.threadTs ?? "";
    // No extension filtering on either route: both are explicit "deliver this"
    // now that intent is no longer inferred from writes, so a .csv or .xlsx
    // goes through like anything else.
    const fromOutbox: OutboundCandidate[] = outboxAdditions(cwd, sources.outboxBaseline).map((path) => ({ path }));
    const fromTranscript = sources.confirmed;

    let candidates = fromTranscript;
    if (fromOutbox.length > 0) {
      const ownership = await this.outboxOwnership(pairing, cwd);
      if (ownership.sole) {
        // Transcript entries first, so their caption survives dedup against the
        // same file also sitting in the outbox.
        candidates = [...fromTranscript, ...fromOutbox];
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
          // The agent's own caption when it gave one — it says why the file is
          // here, which the filename alone doesn't.
          comment: f.caption ? `📎 ${f.caption}` : `📎 ${f.name}`,
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
