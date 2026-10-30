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
import type { Terminals } from "./backend/index.js";
import {
  ExpectationLost,
  hasUnsendableC0Controls,
  SubmitRefused,
  UNSENDABLE_TEXT_MESSAGE,
  WriteOutcomeUnknown,
  WRITE_OUTCOME_UNKNOWN_MESSAGE,
} from "./backend/types.js";
import type { AgentInfo, AgentRef, AgentStatus, BackendName, ScreenSnapshot, TranscriptIdentity } from "./backend/types.js";
import { draftStashedText, submitRefusedText, writeOutcomeUnknownText } from "./backend/submit-notice.js";
import { backendForTarget } from "./backend/target.js";
import { PaneLeaseRegistry, type PaneLease } from "./leases.js";
import { EMPTY_TRANSCRIPT_BOUNDARIES, resolveStatus, SettleTracker, transcriptBoundaries, type StatusResolution } from "./settle.js";
import type { Pairing } from "./pairing.js";
import { isUnsupportedByRemote, type MessageHandle, type Notifier } from "./notifier.js";
import { readNewRecords, readRecentRecords, transcriptSizeSafe } from "./agents/transcript.js";
import { driverFor, type AgentDriver, type AskUserQuestionPaneInfo, type BlockedPrompt } from "./agents/driver.js";
import { promptFingerprint } from "./agents/fingerprint.js";
import {
  createOmpStatusMemory,
  markOmpNoticePosted,
  resolveOmpStatus,
  type OmpStatusMemory,
  type OmpStatusResolution,
} from "./agents/omp/status.js";
import { chunkForSlack, markdownToMrkdwn } from "./slack/mrkdwn.js";
import { postSegmented } from "./slack/post.js";
import {
  askUserQuestionAnsweredText,
  askUserQuestionBlocks,
  doneStatusText,
  permissionBlocks,
  permissionParseFailureBlocks,
  unreadableQuestionBlocks,
  terminalAnswerBlocks,
} from "./slack/blocks.js";
import { randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { OMP_RESUME_NOTICE } from "./agents/omp/driver.js";
import { CODEX_ORCA_TERMINAL_ANSWER, CODEX_THREAD_SWITCHED } from "./agents/codex/driver.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sameTranscriptIdentity(
  left: TranscriptIdentity | undefined,
  right: TranscriptIdentity | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.path === right.path &&
    left.device === right.device &&
    left.inode === right.inode
  );
}

const PROMPT_ID_LIMIT = 2 ** 48;
const issuedPromptIds = new Set<number>();

function nextPromptId(): number {
  if (issuedPromptIds.size >= PROMPT_ID_LIMIT - 1) {
    throw new Error("prompt ID space exhausted");
  }
  let id: number;
  do {
    id = randomInt(1, PROMPT_ID_LIMIT);
  } while (issuedPromptIds.has(id));
  issuedPromptIds.add(id);
  return id;
}

/**
 * A reply that is nothing but option numbers, as 0-based indices — or null when
 * it is anything else.
 *
 * Full-width commas and the Japanese enumeration comma are accepted because a
 * reply typed on a Japanese keyboard uses them. A single number counts: picking
 * one option out of a multi-select list is an ordinary thing to want.
 *
 * Returns null for a duplicate, since toggling the same box twice would turn it
 * back off — better to pass "1,1" through as text than to submit nothing.
 */
function optionNumbersIn(text: string, info: AskUserQuestionPaneInfo): number[] | null {
  if (!info.multiSelect) return null;
  const trimmed = text.trim();
  if (!/^\d+(?:\s*[,、，]\s*\d+)*$/.test(trimmed)) return null;
  const nums = trimmed.split(/[,、，]/).map((t) => Number(t.trim()));
  if (nums.some((n) => !Number.isInteger(n) || n < 1 || n > info.options.length)) return null;
  const indices = nums.map((n) => n - 1);
  if (new Set(indices).size !== indices.length) return null;
  return indices;
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

export type TurnPhase = "running" | "awaiting-question" | "awaiting-permission" | "awaiting-omp";

interface TurnState {
  phase: TurnPhase;
  pairing: Pairing;
  requesterUserId: string;
  driver: AgentDriver;
  backend: BackendName;
  ref: AgentRef;
  paneId: string;
  /** Live cwd of the pane, read at turn start — the outbox lives under it. */
  cwd: string;
  sessionId: string;
  transcriptPath: string;
  transcriptIdentity?: TranscriptIdentity;
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
   * A confirmed blocked status refreshes this deadline because the prompt is
   * waiting on a person. An incomplete screen preserves the previous deadline,
   * so a stale blocked status cannot extend an unreadable turn indefinitely.
   * Without refreshing a confirmed prompt, it timed out on schedule, finalized
   * the turn, and BackgroundWatcher re-adopted it and posted it once per timeout.
   */
  deadlineAt: number;
  /**
   * Decides completion from the agent's transcript rather than trusting a
   * backend status that may not clear — see settle.ts. Owned per turn: it
   * carries the turn's open/closed state, so it must not outlive it.
   */
  settle: SettleTracker;
  /**
   * When this Slack turn's prompt was sent, until its transcript first grows;
   * undefined once it has, and for a turn with no transcript to watch.
   *
   * An idle pane whose transcript never moved has not answered — it never got
   * the prompt. Measured 2026-10-27: `claude --resume` stalled on a sign-in
   * dialog before drawing anything, herdr reported the pane `idle`, and the
   * turn was closed as "完了（テキスト応答なし）" eleven seconds in while the
   * session's transcript held no trace of the message.
   */
  awaitingFirstRecordSince?: number;
  /** OMP's consecutive-screen and one-notice-per-fingerprint memory. */
  ompStatus: OmpStatusMemory | null;
  ompNoticeText?: string;
  /** Last resolved status, retained only for this turn's incomplete-screen path. */
  previousStatus: AgentStatus;
  /**
   * Consecutive failures per terminal operation, each reset only by that same
   * operation succeeding.
   *
   * One shared counter did not work: get runs first on every poll, so its
   * success reset the count before read was even attempted. A terminal whose
   * reads failed persistently therefore never got past "first failure", and —
   * being blocked — had its deadline pushed forward each time too, so the turn
   * held the terminal forever while making no progress at all.
   */
  failures: { get: number; read: number };
  /** This turn's claim on the pane. Its signal is what the poll loop watches,
   *  so cancelling the lease stops the loop; released by finalize/abort. */
  lease: PaneLease;
  // Process-unique across all turns, so an old button can never name a new prompt.
  promptId: number | null;
  /** Identity of the prompt `promptHandle` is showing, so a different one
   *  appearing while the pane stays `blocked` is detectable. Null when the pane
   *  didn't parse — never compared in that case (see promptFingerprint). */
  promptFingerprint?: string | null;
  /**
   * Set synchronously before any answer write, then cleared when the prompt is
   * resolved or a pre-write attempt fails. An unknown write outcome clears the
   * prompt ID but leaves this claimed until the pane presents a different prompt.
   */
  answering?: boolean;
  promptHandle?: MessageHandle;
  pendingPrompt?: BlockedPrompt;
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
  /** Overrides FIRST_RECORD_GRACE_MS; for tests. */
  firstRecordGraceMs?: number;
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
/** How long an idle pane may leave a just-sent prompt unrecorded before cctag says it never arrived. */
export const FIRST_RECORD_GRACE_MS = 30_000;
const PROMPT_NOT_RECEIVED =
  "⚠️ エージェントがこのメッセージを受け取った記録がありません（transcriptに何も書かれていません）。" +
  "エージェントが起動途中や認証待ちで、まだ入力を受け付けていない可能性があります。端末を確かめて、動き出してからもう一度送ってください。";

/**
 * How many backend queries in a row may fail before a turn gives up on its terminal.
 *
 * Each query already has its own 15s timeout, so this tolerates roughly a
 * minute of the backend being unreachable — long enough to ride out a restart
 * without abandoning a turn whose agent is still working perfectly well.
 */
const BACKEND_FAILURES_BEFORE_GIVING_UP = 3;

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
  backend: BackendName;
  driver: AgentDriver;
  sessionId: string;
  transcriptPath: string;
  transcriptIdentity?: TranscriptIdentity;
  offset: number;
  collected: string[];
  paneId: string;
  ref: AgentRef;
  /** Live pane cwd — the adopted turn needs it to find the outbox. */
  cwd: string;
  /** The watcher's outbox snapshot, NOT a fresh one: re-baselining at adoption
   *  time would classify everything the agent produced before it blocked as
   *  pre-existing, and none of it would ever be posted. */
  outboxBaseline: DirSnapshot;
  /** Write tracking so far, handed over rather than restarted for the same
   *  reason — a write confirmed before the block still needs uploading. */
  writes: WrittenFileTracker;
  /** Handoff evidence already confirmed twice by the watcher. */
  ompStatus?: OmpStatusMemory;
  ompNotice?: string;
  ompFingerprint?: string;
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
    private readonly terminals: Terminals,
    private readonly notifier: Notifier,
    private readonly opts: TurnEngineOptions,
    /** Read (never mutated) to tell whether this pane's cwd is shared with
     *  another paired thread — see uploadAttachments. */
    private readonly pairings: { list(): Pairing[] },
  ) {}

  isBusy(paneId: string): boolean {
    return this.leases.isHeld(paneId);
  }
  isOmpWaiting(paneId: string): boolean {
    const state = this.turns.get(paneId);
    return state?.driver.kind === "omp" && (state.phase === "awaiting-omp" || state.previousStatus === "blocked");
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
      const agent = await this.terminals.get(paneId);
      if (!agent) {
        throw new Error("agent-not-found");
      }
      if (lease.cancelled) return;
      const driver = driverFor(agent.agent);
      const backend = backendForTarget(agent.ref.target);
      if (backend === "orca" && hasUnsendableC0Controls(text)) {
        await this.notifier.postReply(
          pairing.channel,
          pairing.threadTs ?? "",
          submitRefusedText("unsafe-text", backend),
        );
        return;
      }


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
      const tPath = agent.transcriptIdentity?.path ?? driver.locateTranscript(agent.cwd, agent.sessionId) ?? "";
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
        const paneText = await this.terminals
          .read(agent.ref.target, 40, driver.readRegion)
          .then((snapshot) => snapshot.text)
          .catch(() => "");
        const question = paneText ? driver.parseStartupPrompt(paneText) : null;
        if (question) {
          await this.notifier.postReply(
            pairing.channel,
            pairing.threadTs ?? "",
            `⚠️ ペインが起動時のダイアログで停止しています。このダイアログは端末で答えてください。\n` +
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
        backend,
        ref: agent.ref,
        paneId: agent.ref.target,
        cwd: agent.cwd,
        sessionId,
        transcriptPath: tPath,
        transcriptIdentity: agent.transcriptIdentity,
        offset,
        collected: [],
        outboxBaseline: snapshotOutbox(agent.cwd),
        writes: new WrittenFileTracker(),
        toolCounts: {},
        statusHandle,
        lastStatusUpdateAt: 0,
        startedAt: Date.now(),
        deadlineAt: Date.now() + this.opts.turnTimeoutMs,
        settle: new SettleTracker(),
        previousStatus: "working",
        failures: { get: 0, read: 0 },
        lease,
        promptId: null,
        ompStatus: driver.kind === "omp" ? createOmpStatusMemory() : null,
        awaitingFirstRecordSince: tPath && driver.kind !== "omp" ? Date.now() : undefined,
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
        const canVerify = tPath !== "";
        const retries = prepared.imageCount > 0 && canVerify ? SUBMIT_RETRIES_WITH_IMAGES : 1;
        const outcome = await this.terminals.submit(agent.ref, normalized, {
          driver,
          cancelled: () => lease.cancelled,
          transcriptGrew: () => (canVerify ? transcriptSizeSafe(tPath) > offset : null),
          retryLimit: retries,
          pollIntervalMs: this.opts.pollIntervalMs,
        });
        if (outcome.draftStashed) {
          await this.notifier
            .postReply(pairing.channel, pairing.threadTs ?? "", draftStashedText(backend))
            .catch(() => {});
        }
        if (backend === "orca" && outcome.status === "accepted") {
          await statusHandle.update(`📨 ${backend} は入力を受け付けました。ターン開始を確認しています…`).catch(() => {});
        }
      } catch (err) {
        // Input injection failed after the state was already registered —
        // roll it back so the terminal doesn't stay stuck "busy" forever.
        this.turns.delete(paneId);
        if (err instanceof SubmitRefused) {
          await statusHandle.update(submitRefusedText(err.reason, backend, err.composer)).catch(() => {});
          return;
        }
        if (err instanceof WriteOutcomeUnknown) {
          await statusHandle.update(writeOutcomeUnknownText(err)).catch(() => {});
          return;
        }
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
   * BackgroundWatcher calls this when a paired terminal has become blocked
   * without an active Slack turn. Interactive drivers expose the prompt for
   * Slack answers; OMP carries its confirmed screen notice here and stays
   * terminal-only.
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

      // The prompt on screen means this turn is already under way, so the
      // tracker starts `running` rather than waiting for a start record that
      // was written before the handoff's offset — see markTurnRunning.
      const adoptedSettle = new SettleTracker();
      adoptedSettle.markTurnRunning();

      const state: TurnState = {
        phase: "running",
        pairing,
        requesterUserId: pairing.pairedBy,
        driver: handoff.driver,
        backend: handoff.backend,
        ref: handoff.ref,
        paneId: handoff.paneId,
        cwd: handoff.cwd,
        sessionId: handoff.sessionId,
        transcriptPath: handoff.transcriptPath,
        transcriptIdentity: handoff.transcriptIdentity,
        offset: handoff.offset,
        collected: [...handoff.collected],
        outboxBaseline: handoff.outboxBaseline,
        writes: handoff.writes,
        toolCounts: {},
        statusHandle,
        lastStatusUpdateAt: 0,
        startedAt: Date.now(),
        deadlineAt: Date.now() + this.opts.turnTimeoutMs,
        settle: adoptedSettle,
        previousStatus: "blocked",
        failures: { get: 0, read: 0 },
        lease,
        promptId: null,
        ompStatus:
          handoff.driver.kind === "omp" ? (handoff.ompStatus ?? createOmpStatusMemory()) : null,
      };
      this.turns.set(paneId, state);

      // Same check as startTurn: the status message above is an await, and a
      // cancel landing inside it would otherwise start a loop for a pane nobody
      // is listening to any more.
      if (lease.cancelled) {
        this.turns.delete(paneId);
        return false;
      }
      if (
        handoff.driver.kind === "omp" &&
        handoff.ompNotice &&
        handoff.ompFingerprint
      ) {
        await this.postOmpNotice(state, handoff.ompNotice, handoff.ompFingerprint);
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

  async answerQuestionButton(
    paneId: string,
    promptId: number,
    optionIndex: number,
    pairingKey: string | undefined,
    /** Set only when somebody other than the owner pressed it — see
     *  CommandHandler.actorLabel for why the owner's own answers stay unmarked. */
    actor?: string,
  ): Promise<AnswerResult> {
    const state = this.turns.get(paneId);
    if (
      !state ||
      state.phase !== "awaiting-question" ||
      state.promptId !== promptId ||
      state.pairing.key !== pairingKey ||
      !state.pendingQuestionInfo ||
      state.answering
    ) {
      return { ok: false, reason: "not-pending" };
    }
    const prompt = state.pendingPrompt;
    if (!prompt || prompt.kind !== "question" || !("verified" in prompt)) {
      return { ok: false, reason: "not-pending" };
    }
    const info = state.pendingQuestionInfo;
    const label = info.options[optionIndex]?.label;
    if (label === undefined) return { ok: false, reason: "not-pending" };

    state.answering = true; // claimed — see TurnState.answering
    try {
      const channel = this.terminals.openAnswer(state.ref, prompt.verified);
      if (state.driver.answerQuestionOption) {
        await state.driver.answerQuestionOption(
          this.terminals,
          channel,
          state.paneId,
          optionIndex + 1,
          info,
          state.lease.signal,
        );
      } else {
        await state.driver.answerOption(channel, String(optionIndex + 1), label);
      }
    } catch (err) {
      return this.handleAnswerFailure(state, err);
    }
    await state.promptHandle?.update(askUserQuestionAnsweredText(info.header, label, actor), []).catch(() => {});
    this.markPromptResolved(state);
    await this.restartStatusLine(state);
    return { ok: true };
  }

  async answerQuestionMultiSelect(
    paneId: string,
    promptId: number,
    optionIndices: number[],
    pairingKey: string | undefined,
    actor?: string,
  ): Promise<AnswerResult> {
    const state = this.turns.get(paneId);
    if (
      !state ||
      state.phase !== "awaiting-question" ||
      state.promptId !== promptId ||
      state.pairing.key !== pairingKey ||
      !state.pendingQuestionInfo ||
      state.answering
    ) {
      return { ok: false, reason: "not-pending" };
    }
    const info = state.pendingQuestionInfo;
    const submit = state.driver.answerQuestionMultiSelect;
    const prompt = state.pendingPrompt;
    if (!submit || !info.multiSelect || !prompt || prompt.kind !== "question" || !("verified" in prompt)) {
      return { ok: false, reason: "not-pending" };
    }

    const chosen = optionIndices.filter((i) => i >= 0 && i < info.options.length);
    if (chosen.length === 0) return { ok: false, reason: "not-pending" };

    state.answering = true; // claimed — see TurnState.answering
    try {
      await submit(
        this.terminals,
        this.terminals.openAnswer(state.ref, prompt.verified),
        state.ref,
        chosen.map((i) => i + 1),
        info,
        state.lease.signal,
      );
    } catch (err) {
      return this.handleAnswerFailure(state, err);
    }
    const labels = chosen.map((i) => info.options[i].label).join(", ");
    await state.promptHandle?.update(askUserQuestionAnsweredText(info.header, labels, actor), []).catch(() => {});
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
    const prompt = state.pendingPrompt;
    if (!prompt || prompt.kind !== "question" || !("verified" in prompt)) {
      return { ok: false, reason: "not-pending" };
    }

    // "1,3" to a multi-select question means options 1 and 3, not the literal
    // string. Claude Code does not read it that way — the free-text row records
    // whatever was typed, verbatim, so the agent received "1,3" and had to guess
    // — and it is what a reader types anyway, reported from real use before the
    // checkboxes existed. Only for multi-select, only when every token is a
    // valid option number: anything else stays free text, where a genuine answer
    // of "1,3" still gets through unchanged on a single-select question.
    const asIndices = optionNumbersIn(freeText, info);
    if (asIndices && state.driver.answerQuestionMultiSelect && state.promptId !== null) {
      return this.answerQuestionMultiSelect(paneId, state.promptId, asIndices, state.pairing.key);
    }

    const answer = state.driver.answerQuestionFreeText;
    if (!answer) return { ok: false, reason: "not-pending" };

    state.answering = true;
    try {
      await answer(
        this.terminals,
        this.terminals.openAnswer(state.ref, prompt.verified),
        state.ref,
        info,
        freeText,
        state.lease.signal,
      );
    } catch (err) {
      return this.handleAnswerFailure(state, err);
    }
    await state.promptHandle?.update(askUserQuestionAnsweredText(info.header, freeText), []).catch(() => {});
    this.markPromptResolved(state);
    await this.restartStatusLine(state);
    return { ok: true };
  }

  async answerPermissionButton(
    paneId: string,
    promptId: number,
    num: string,
    pairingKey: string | undefined,
    /** See answerQuestionButton's. */
    actor?: string,
  ): Promise<AnswerResult> {
    const state = this.turns.get(paneId);
    if (
      !state ||
      state.phase !== "awaiting-permission" ||
      state.promptId !== promptId ||
      state.pairing.key !== pairingKey ||
      state.answering
    ) {
      return { ok: false, reason: "not-pending" };
    }
    const prompt = state.pendingPrompt;
    if (!prompt) return { ok: false, reason: "not-pending" };

    let answer: () => Promise<void>;
    if (prompt.kind === "blind-permission") {
      if (num !== "y" && num !== "n") return { ok: false, reason: "not-pending" };
      answer = () => this.terminals.openBlind(state.ref, prompt.blind).answer(num);
    } else if (prompt.kind === "permission") {
      const choice = prompt.menu.choices.find((candidate) => candidate.num === num);
      if (!choice) return { ok: false, reason: "not-pending" };
      const channel = this.terminals.openAnswer(state.ref, prompt.verified);
      answer = () => state.driver.answerOption(channel, num, choice.label);
    } else {
      return { ok: false, reason: "not-pending" };
    }

    state.answering = true;
    try {
      await answer();
    } catch (err) {
      return this.handleAnswerFailure(state, err);
    }
    const by = actor ? `（${actor}）` : "";
    await state.promptHandle?.update(`→ ${num} を送信しました${by}`, []).catch(() => {});
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
    const prompt = state.pendingPrompt;
    const answer = state.driver.answerPlanFeedback;
    if (!answer || !prompt || prompt.kind !== "permission") return { ok: false, reason: "not-pending" };
    if (!prompt.menu.choices.some((choice) => choice.num === String(state.planFeedbackOptionNum))) {
      return { ok: false, reason: "not-pending" };
    }

    if (state.backend === "orca" && hasUnsendableC0Controls(freeText)) {
      throw new ExpectationLost(UNSENDABLE_TEXT_MESSAGE, UNSENDABLE_TEXT_MESSAGE);
    }
    state.answering = true;
    try {
      await answer(
        this.terminals.openAnswer(state.ref, prompt.verified),
        state.planFeedbackOptionNum,
        freeText,
      );
    } catch (err) {
      return this.handleAnswerFailure(state, err);
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
  /**
   * What replaces a prompt message once it turns out to have been answered at
   * the keyboard instead of from Slack.
   *
   * It used to be the bare note, which erased the question and its options — so
   * a thread showed that *something* had been asked and answered, with no way to
   * see what. Reported from production: a four-question dialog whose second
   * question was multi-select left exactly one line of evidence, and it said
   * nothing about the question. The same class of loss as the raw pane dumps
   * postPrompt now logs, and the fix is easier here because the question is
   * still in hand. A permission prompt keeps the bare note: its snippet is
   * already logged on the path that cannot read it.
   */
  private answeredAtTerminalText(state: TurnState): string {
    const info = state.pendingQuestionInfo;
    if (!info) return "（ターミナル側で回答済み）";
    const options = info.options.map((o, i) => `${i + 1}. ${o.label}`).join("\n");
    return `❓ *${info.header}*: ${info.question}\n${options}\n\n（ターミナル側で回答済み）`;
  }

  private async handleAnswerFailure(state: TurnState, error: unknown): Promise<AnswerResult> {
    if (error instanceof WriteOutcomeUnknown) {
      state.promptId = null;
      state.answering = true;
      await state.promptHandle?.update(WRITE_OUTCOME_UNKNOWN_MESSAGE, []).catch(() => {});
      return { ok: true };
    }
    state.answering = false;
    throw error;
  }

  private markPromptResolved(state: TurnState): void {
    state.promptId = null;
    state.promptHandle = undefined;
    state.promptFingerprint = undefined;
    state.pendingPrompt = undefined;
    state.pendingQuestionInfo = undefined;
    state.planFeedbackOptionNum = undefined;
    state.answering = false;
    state.phase = "running";
    state.ompNoticeText = undefined;
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
    const promptId = nextPromptId();
    state.promptId = promptId;
    state.promptFingerprint = fingerprint;
    state.pendingPrompt = prompt;
    state.answering = false;

    if (prompt.kind === "question") {
      const aq = prompt.info;
      state.pendingQuestionInfo = aq;
      state.promptHandle = await this.notifier.postMessage(
        state.pairing.channel,
        state.pairing.threadTs ?? "",
        `❓ ${aq.header}: ${aq.question}`,
        askUserQuestionBlocks(paneId, promptId, aq),
      );
      state.phase = "awaiting-question";
      return;
    }

    const menu = prompt.kind === "permission" ? prompt.menu : null;
    const isPlanPrompt = prompt.kind === "permission" && prompt.isPlanPrompt;
    const feedbackNum = prompt.kind === "permission" ? prompt.planFeedbackOptionNum : undefined;
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

    if (!buttonMenu) {
      console.error(
        `[turn ${paneId}] could not parse the prompt on screen (question-shaped: ${
          prompt.kind === "unreadable-question"
        }). Raw pane follows:\n${paneText}`,
      );
    }

    const unreadableQuestion = prompt.kind === "unreadable-question";
    if (state.backend === "orca" && state.driver.kind === "codex") {
      state.promptHandle = await this.notifier.postMessage(
        state.pairing.channel,
        state.pairing.threadTs ?? "",
        CODEX_ORCA_TERMINAL_ANSWER,
        terminalAnswerBlocks(CODEX_ORCA_TERMINAL_ANSWER, paneText),
      );
      state.phase = "awaiting-permission";
      return;
    }
    const header = isPlanPrompt
      ? "📋 プランが提示されました。ボタンで承認するか、修正内容をこのスレッドに返信してください。"
      : unreadableQuestion
        ? "⚠️ 質問を読み取れませんでした（ターミナルで回答してください）"
        : "⚠️ 許可リクエスト";
    state.promptHandle = await this.notifier.postMessage(
      state.pairing.channel,
      state.pairing.threadTs ?? "",
      header,
      buttonMenu
        ? permissionBlocks(paneId, promptId, buttonMenu, isPlanPrompt ? header : undefined)
        : unreadableQuestion
          ? unreadableQuestionBlocks(paneText)
          : permissionParseFailureBlocks(paneId, promptId, paneText),
    );
    state.phase = "awaiting-permission";
  }

  private async postOmpNotice(state: TurnState, text: string, fingerprint: string): Promise<void> {
    try {
      const handle = await this.notifier.postMessage(state.pairing.channel, state.pairing.threadTs ?? "", text);
      state.promptHandle = handle;
      state.promptFingerprint = fingerprint;
      state.promptId = null;
      state.pendingPrompt = undefined;
      state.pendingQuestionInfo = undefined;
      state.planFeedbackOptionNum = undefined;
      state.answering = false;
      state.ompNoticeText = text;
      if (state.ompStatus) state.ompStatus = markOmpNoticePosted(state.ompStatus, fingerprint);
      state.phase = "awaiting-omp";
    } catch (error) {
      console.error(
        `[turn ${state.paneId}] OMP waiting notice post failed:`,
        error instanceof Error ? error.message : error,
      );
    }
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

  private switchOmpSession(state: TurnState, agent: AgentInfo): void {
    state.driver = driverFor(agent.agent);
    state.ref = agent.ref;
    state.cwd = agent.cwd;
    state.sessionId = agent.sessionId ?? "";
    state.transcriptIdentity = agent.transcriptIdentity;
    state.transcriptPath = agent.transcriptIdentity?.path ?? "";
    state.offset = state.transcriptPath ? transcriptSizeSafe(state.transcriptPath) : 0;
    state.collected = [];
    state.writes = new WrittenFileTracker();
    state.toolCounts = {};
    state.outboxBaseline = snapshotOutbox(agent.cwd);
    state.settle = new SettleTracker();
    state.previousStatus = "working";
    state.deadlineAt = Date.now() + this.opts.turnTimeoutMs;
    state.ompStatus = agent.agent === "omp" ? createOmpStatusMemory() : null;
  }

  private async revalidateOmpTranscript(
    state: TurnState,
    beforeRead: AgentInfo,
  ): Promise<"same" | "changed" | "lost" | "retry"> {
    let current: AgentInfo | null;
    try {
      current = await this.terminals.get(state.paneId);
      state.failures.get = 0;
    } catch (error) {
      state.failures.get++;
      if (state.failures.get <= BACKEND_FAILURES_BEFORE_GIVING_UP) {
        console.error(
          `[turn ${state.paneId}] OMP transcript ownership query failed (${state.failures.get}/${BACKEND_FAILURES_BEFORE_GIVING_UP}), retrying:`,
          error instanceof Error ? error.message : error,
        );
        return "retry";
      }
      await this.finalize(state, `⚠️ ${state.backend}への問い合わせが連続して失敗しました（部分的な出力のみ）`);
      return "lost";
    }
    if (!current || current.agent !== "omp" || !current.transcriptIdentity) {
      state.collected = [];
      state.writes = new WrittenFileTracker();
      await this.finalize(state, OMP_RESUME_NOTICE);
      return "lost";
    }
    if (
      current.sessionId !== beforeRead.sessionId ||
      !sameTranscriptIdentity(current.transcriptIdentity, beforeRead.transcriptIdentity)
    ) {
      this.switchOmpSession(state, current);
      return "changed";
    }
    return "same";
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
      // conflated: the Herdr adapter's get returns null only for its own "no
      // such pane" answer, but throws for a command timeout, spawn failure, or
      // output it cannot parse. Treating the second as a dead pane ended live
      // turns on a transient hiccup and handed the pane to the watcher, which
      // rebaselines and drops the rest of the output.
      let agent: AgentInfo | null;
      try {
        agent = await this.terminals.get(paneId);
        state.failures.get = 0;
      } catch (err) {
        state.failures.get += 1;
        if (state.failures.get <= BACKEND_FAILURES_BEFORE_GIVING_UP) {
          console.error(
            `[turn ${paneId}] ${state.backend} query failed (${state.failures.get}/${BACKEND_FAILURES_BEFORE_GIVING_UP}), retrying:`,
            err instanceof Error ? err.message : err,
          );
          continue;
        }
        await this.finalize(
          state,
          `⚠️ ${state.backend}への問い合わせが連続して失敗しました（部分的な出力のみ）`,
        );
        return;
      }
      if (!agent) {
        await this.finalize(
          state,
          state.driver.kind === "omp" ? OMP_RESUME_NOTICE : "⚠️ インスタンスが終了しました（部分的な出力のみ）",
        );
        return;
      }
      if (state.driver.kind === "omp" && agent.agent !== "omp") {
        state.collected = [];
        state.writes = new WrittenFileTracker();
        await this.finalize(state, OMP_RESUME_NOTICE);
        return;
      }

      const sessionChanged = Boolean(agent.sessionId && agent.sessionId !== state.sessionId);
      const identityChanged =
        state.driver.kind === "omp" &&
        !sameTranscriptIdentity(state.transcriptIdentity, agent.transcriptIdentity);
      if (sessionChanged && state.driver.kind === "codex" && agent.transcriptIdentity) {
        // Not followed into the new rollout: from 0 it replays the resumed thread's history, and
        // from its end the turn never sees a start and holds the pane until the timeout.
        await this.finalize(state, CODEX_THREAD_SWITCHED);
        return;
      }
      if (sessionChanged || identityChanged) {
        if (state.driver.kind === "omp") {
          this.switchOmpSession(state, agent);
        } else {
          state.sessionId = agent.sessionId ?? "";
          state.transcriptIdentity = agent.transcriptIdentity;
          state.transcriptPath =
            agent.transcriptIdentity?.path ?? state.driver.locateTranscript(agent.cwd, agent.sessionId) ?? "";
          state.offset = 0;
          // A new session is the agent acting on the prompt (`/clear`, a resume).
          state.awaitingFirstRecordSince = undefined;
          // Session-local lifecycle and screen evidence must not leak to this transcript.
          state.settle = new SettleTracker();
          state.previousStatus = "working";
        }
      } else if (!state.transcriptPath) {
        // Retry the cwd-based fallback if transcript creation was delayed.
        const located =
          agent.transcriptIdentity?.path ?? state.driver.locateTranscript(agent.cwd, agent.sessionId) ?? "";
        if (located) {
          state.transcriptPath = located;
          state.transcriptIdentity = agent.transcriptIdentity;
          state.offset = state.driver.kind === "omp" ? transcriptSizeSafe(located) : 0;
        }
      }

      if (state.transcriptPath) {
        const readOffset = state.offset;
        const { records, newOffset } = await readNewRecords(state.transcriptPath, readOffset);
        if (state.driver.kind === "omp") {
          const ownership = await this.revalidateOmpTranscript(state, agent);
          if (ownership === "lost") return;
          if (ownership !== "same") continue;
        }
        const grew = newOffset > readOffset;
        state.offset = newOffset;
        const output = state.driver.extractTurnOutput(records);
        state.collected.push(...output.texts);
        for (const name of output.toolNames) {
          state.toolCounts[name] = (state.toolCounts[name] ?? 0) + 1;
        }
        state.writes.ingest(output);
        state.settle.observe(output.lifecycle ?? []);
        // Transcript growth proves the agent is alive and working.
        if (grew) {
          state.deadlineAt = Date.now() + this.opts.turnTimeoutMs;
          state.awaitingFirstRecordSince = undefined;
        }
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
      // Shared resolution preserves herdr's classified correction and applies
      // Orca's timestamp/status hints without confusing either with output offsets.
      let boundaries = EMPTY_TRANSCRIPT_BOUNDARIES;
      if (agent.evidence.kind === "hint" && state.transcriptPath) {
        const recentRecords = await readRecentRecords(state.transcriptPath);
        if (state.driver.kind === "omp") {
          const ownership = await this.revalidateOmpTranscript(state, agent);
          if (ownership === "lost") return;
          if (ownership !== "same") continue;
        }
        boundaries = transcriptBoundaries(state.driver.extractLifecycle(recentRecords));
      }

      let resolution: StatusResolution;
      let ompResolution: OmpStatusResolution | null = null;
      if (state.driver.kind === "omp") {
        let snapshot: ScreenSnapshot | null = null;
        try {
          snapshot = await this.terminals.read(state.paneId, BLOCKED_PANE_LINES, "screen");
          state.failures.read = 0;
        } catch (error) {
          state.failures.read++;
          if (state.failures.read === 1) {
            console.error(
              `[turn ${paneId}] OMP screen read failed; retaining prior state:`,
              error instanceof Error ? error.message : error,
            );
          }
        }
        if (state.transcriptPath) {
          const ownership = await this.revalidateOmpTranscript(state, agent);
          if (ownership === "lost") return;
          if (ownership !== "same") continue;
        }
        ompResolution = resolveOmpStatus({
          settle: state.settle,
          boundaries,
          previousStatus: state.previousStatus,
          memory: state.ompStatus ?? createOmpStatusMemory(),
          snapshot,
        });
        state.ompStatus = ompResolution.memory;
        resolution = ompResolution;
      } else {
        resolution = await resolveStatus({
          evidence: agent.evidence,
          settle: state.settle,
          boundaries,
          previousStatus: state.previousStatus,
          readScreen: async () => {
            const snapshot = await this.terminals.read(state.paneId, 40, "screen");
            state.failures.read = 0;
            return {
              snapshot,
              fingerprint: snapshot.complete ? promptFingerprint(state.driver.parseBlockedPane(snapshot.text)) : null,
            };
          },
        });
      }
      const status = resolution.status;
      state.previousStatus = status;
      const blocked = status === "blocked";
      if (resolution.extendDeadline) state.deadlineAt = Date.now() + this.opts.turnTimeoutMs;

      if (Date.now() > state.deadlineAt) {
        await this.finalize(state, "⚠️ タイムアウトしました（エージェントはまだ動作中の可能性があります）");
        return;
      }

      if (blocked) {
        if (state.driver.kind === "omp") {
          if (ompResolution?.notice && ompResolution.fingerprint) {
            await this.postOmpNotice(state, ompResolution.notice, ompResolution.fingerprint);
          }
          continue;
        }
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
          if (resolution.screen) {
            paneText = resolution.screen.text;
          } else {
            paneText = (
              await this.terminals.read(state.paneId, BLOCKED_PANE_LINES, state.driver.readRegion)
            ).text;
          }
          state.failures.read = 0;
        } catch (err) {
          state.failures.read += 1;
          if (state.failures.read <= BACKEND_FAILURES_BEFORE_GIVING_UP) {
            console.error(
              `[turn ${paneId}] pane read failed (${state.failures.read}/${BACKEND_FAILURES_BEFORE_GIVING_UP}), retrying:`,
              err instanceof Error ? err.message : err,
            );
            continue;
          }
          await this.finalize(
            state,
            `⚠️ ${state.backend}への問い合わせが連続して失敗しました（部分的な出力のみ）`,
          );
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
          await state.promptHandle?.update(this.answeredAtTerminalText(state), []).catch(() => {});
          state.pendingQuestionInfo = undefined;
          state.planFeedbackOptionNum = undefined;
          await this.postPrompt(state, paneText, prompt, fingerprint);
        }
        // else: still the same prompt we already posted — keep waiting.
        continue;
      }
      if (
        state.driver.kind === "omp" &&
        state.phase === "awaiting-omp" &&
        !ompResolution?.releaseBlocked
      ) {
        continue;
      }

      if (state.phase !== "running") {
        // Was awaiting an answer, and the terminal is no longer blocked —
        // resolved, either by our own button/free-text (which already
        // cleared promptHandle) or directly at the terminal keyboard.
        const resolvedText =
          state.driver.kind === "omp" && state.ompNoticeText
            ? `${state.ompNoticeText}\n\n（ターミナル側で回答済み）`
            : this.answeredAtTerminalText(state);
        await state.promptHandle?.update(resolvedText, []).catch(() => {});
        this.markPromptResolved(state);
      }

      if (status === "idle" || status === "done") {
        if (state.awaitingFirstRecordSince !== undefined) {
          // The agent may simply not have written its first record yet.
          if (Date.now() - state.awaitingFirstRecordSince < (this.opts.firstRecordGraceMs ?? FIRST_RECORD_GRACE_MS)) continue;
          await this.finalize(state, PROMPT_NOT_RECEIVED);
          return;
        }
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
          : `⚠️ transcriptが見つからず、応答テキストを読み取れませんでした（${state.backend}がsessionIdを報告できていない可能性があります）。`;
    }
    if (warning) {
      await this.notifier.postReply(state.pairing.channel, state.pairing.threadTs ?? "", warning);
    }
    const label = text
      ? doneStatusText(elapsed, state.toolCounts)
      : state.awaitingFirstRecordSince !== undefined
        ? `⚠️ 届いていない可能性があります (${elapsed}s)`
        : `✅ 完了 (${elapsed}s)（テキスト応答なし）`;
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
    const result = await this.terminals.list().catch(() => null);
    if (!result || !result.complete) {
      // Ownership can't be established, so it can't be assumed either.
      const backendNames = result?.failures.map((failure) => failure.backend).join(", ");
      const subject = backendNames ? `${backendNames}のインスタンス一覧` : "インスタンス一覧";
      return {
        sole: false,
        reason: `${subject}を取得できず、宛先スレッドを確認できませんでした`,
      };
    }
    const cwdByPane = new Map(result.agents.map((a) => [a.ref.target, a.cwd]));
    const sharing = this.pairings.list().filter((p) => p.key !== pairing.key && cwdByPane.get(p.paneId) === cwd);
    if (sharing.length === 0) return { sole: true };
    return { sole: false, reason: "同じディレクトリに接続されたスレッドが他にもあり、どのスレッド宛てか判別できません" };
  }

  private async uploadAttachments(
    pairing: Pairing,
    cwd: string,
    sources: { outboxBaseline: DirSnapshot; confirmed: OutboundCandidate[] },
  ): Promise<void> {
    const paneId = pairing.paneId;
    const upload = this.notifier.uploadFile?.bind(this.notifier);
    if (!upload) {
      // Silent otherwise: this notifier simply doesn't do uploads (a standalone
      // notifier with no uploadFile, say), which is the common, uninteresting
      // case. Only worth a line when a SendUserFile call was actually confirmed
      // and has nowhere to go — that's the shape of a real incident: the agent
      // reports success, and nothing reaches Slack, with no visible cause.
      if (sources.confirmed.length > 0) {
        console.error(
          `[turn ${paneId}] ${sources.confirmed.length} confirmed SendUserFile request(s) cannot be delivered: this notifier has no uploadFile`,
        );
      }
      return;
    }

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
        console.error(`[turn ${paneId}] outbox auto-attach skipped: ${ownership.reason}`);
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

    // Logged unconditionally past this point, once there's anything to account
    // for: this function otherwise says nothing on success, which is exactly
    // what makes a silent failure here indistinguishable from a silent success.
    // A batch of SendUserFile calls that never reached Slack — reported by the
    // agent as sent, with nothing in the thread and nothing to grep for — is
    // what this line exists to make diagnosable next time.
    const { files, skipped } = readOutboundAttachments(candidates, this.opts.limits, cwd);
    console.log(
      `[turn ${paneId}] attachments: ${candidates.length} candidate(s) ` +
        `(${fromTranscript.length} from SendUserFile, ${fromOutbox.length} from outbox) ` +
        `-> ${files.length} to upload, ${skipped.length} skipped` +
        (skipped.length > 0 ? `: ${skipped.join("; ")}` : ""),
    );

    let uploaded = 0;
    for (const f of files) {
      try {
        await upload(pairing.channel, threadTs, {
          contentB64: f.contentB64,
          filename: f.name,
          // The agent's own caption when it gave one — it says why the file is
          // here, which the filename alone doesn't.
          comment: f.caption ? `📎 ${f.caption}` : `📎 ${f.name}`,
        });
        uploaded += 1;
      } catch (err) {
        // Hub and Spoke ship independently: a Hub without upload_file support
        // answers "no handler", which is worth saying out loud once rather than
        // failing silently every turn.
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[turn ${paneId}] upload failed for ${f.name} (${uploaded}/${files.length} done): ${message}`);
        const reason = isUnsupportedByRemote(err)
          ? "⚠️ Hubがファイル添付に未対応です（Hub側の更新が必要です）。"
          : `⚠️ ${f.name} の添付に失敗しました: ${message}`;
        await this.notifier.postReply(pairing.channel, threadTs, reason).catch(() => {});
        return; // every remaining file would fail the same way
      }
    }
    console.log(`[turn ${paneId}] attachments: ${uploaded}/${files.length} uploaded`);
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
