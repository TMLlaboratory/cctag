import type { HerdrClient } from "./herdr/client.js";
import type { Pairing, PairingStore } from "./pairing.js";
import type { TurnEngine } from "./turn.js";
import type { Notifier } from "./notifier.js";
import { snapshotOutbox, WrittenFileTracker, type DirSnapshot } from "./attachments.js";
import { postSegmented } from "./slack/post.js";
import { readNewRecords, transcriptCreatedAfter, transcriptSizeSafe } from "./agents/transcript.js";
import { driverFor } from "./agents/driver.js";
import { SettleTracker } from "./settle.js";
import { chunkForSlack, markdownToMrkdwn } from "./slack/mrkdwn.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface WatchState {
  sessionId: string;
  transcriptPath: string;
  offset: number;
  /** When this watch was (re)baselined. A transcript created after it holds
   *  nothing this watcher could already have reported. */
  startedAt: number;
  lastStatus: string;
  collected: string[];
  /** `<cwd>/.cctag/outbox` as of the last report, so terminal-initiated work
   *  gets its files attached too — see TurnEngine.uploadOutboxAdditions. */
  outboxBaseline: DirSnapshot;
  /** Write tracking for terminal-initiated work, kept here so it survives to
   *  the report (or to the handoff, if the terminal blocks first). */
  writes: WrittenFileTracker;
  /**
   * Decides settling from the transcript, because herdr's `working` cannot be
   * trusted to clear — see settle.ts. Lives as long as the watch (not the
   * turn): each `started` it sees re-arms it for the next terminal-side turn.
   */
  settle: SettleTracker;
}

/**
 * cctag only watches a paired instance while an active Slack-initiated turn
 * is running (see turn.ts) — outside of that, nothing polls it, so work
 * started directly at the terminal (before pairing, or between Slack turns)
 * finishes invisibly. This watcher covers that gap: for every paired
 * instance with no active turn, it polls at a relaxed interval and posts to
 * the thread when the instance settles (working -> idle/done) with new
 * assistant output.
 *
 * If it instead finds the instance `blocked` — an AskUserQuestion or
 * permission prompt is on screen, waiting on a decision — it doesn't just
 * wait for that to resolve on its own (it might never, if no one's at the
 * keyboard): it hands the terminal off to TurnEngine.adoptBlockedTerminal(),
 * which runs the same pollLoop() a Slack-initiated turn uses, so the prompt
 * gets posted as Slack buttons and can be answered remotely.
 *
 * It deliberately does not replay history: the first time it sees a pairing
 * (including right after an active turn just finished, when it resumes
 * watching) it baselines at the transcript's current end instead of reading
 * from scratch, so it never re-posts what a turn already reported.
 */
/** How often to repeat a still-failing pairing in the log, in ticks. */
const FAILURE_LOG_EVERY = 100;

/**
 * How long a paired pane may sit with no agent in it before the pairing is
 * dropped.
 *
 * The wait exists so quitting the CLI to restart it in the same pane doesn't
 * tear the pairing down (see the agentless branch in checkPairing) — but it
 * has to end. Exiting the agent and leaving the terminal open is the ordinary
 * way to finish a session, and without an upper bound that left the thread
 * paired to an empty pane forever: every message to it failed, and the only
 * signal was one log line at the moment the agent went away.
 *
 * Five minutes is far longer than a restart takes (seconds) and short enough
 * that a thread doesn't stay attached to a pane nobody is working in.
 */
const AGENTLESS_GRACE_MS = 5 * 60_000;

export class BackgroundWatcher {
  private watches = new Map<string, WatchState>(); // key: paneId
  private busyLastTick = new Set<string>();
  /** Consecutive check failures per pane, for log throttling only. */
  private failureStreak = new Map<string, number>();
  /** Panes seen alive but without an agent -> when that was first seen. Both
   *  throttles the log to once per spell and bounds how long the wait lasts
   *  (AGENTLESS_GRACE_MS). */
  private agentlessPanes = new Map<string, number>();

  private running = false;

  constructor(
    private readonly herdr: HerdrClient,
    private readonly pairingStore: PairingStore,
    private readonly turnEngine: TurnEngine,
    private readonly notifier: Notifier,
    private readonly intervalMs = 7_000,
    /** Overridable for tests only — production always wants AGENTLESS_GRACE_MS. */
    private readonly agentlessGraceMs = AGENTLESS_GRACE_MS,
  ) {}

  start(): void {
    this.running = true;
    void this.loop();
  }

  /** Stops the poll loop. Needed in Spoke mode, where a fresh watcher (tied to the new
   * WebSocket-backed notifier) is created on every reconnect — without this the old
   * loop from a previous connection would keep running forever alongside it. */
  stop(): void {
    this.running = false;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      await sleep(this.intervalMs);
      if (!this.running) break;
      await this.tick().catch((err) => console.error("[watcher] tick failed:", err));
    }
  }

  private async tick(): Promise<void> {
    const pairings = this.pairingStore.list();
    const liveKeys = new Set(pairings.map((p) => p.paneId));
    for (const key of this.watches.keys()) {
      if (!liveKeys.has(key)) {
        this.watches.delete(key);
        this.busyLastTick.delete(key);
        this.failureStreak.delete(key);
        this.agentlessPanes.delete(key);
      }
    }

    for (const pairing of pairings) {
      if (this.turnEngine.isBusy(pairing.paneId)) {
        this.busyLastTick.add(pairing.paneId);
        continue;
      }
      const resumingFromActiveTurn = this.busyLastTick.delete(pairing.paneId);
      try {
        await this.checkPairing(pairing, resumingFromActiveTurn);
        this.failureStreak.delete(pairing.paneId);
      } catch (err) {
        // Kept, not consumed: this tick achieved nothing, so the next one still
        // has to rebaseline or it would read a transcript from before the turn
        // that just ended and replay it.
        if (resumingFromActiveTurn) this.busyLastTick.add(pairing.paneId);

        // Only the first of a run is logged in full. herdr's server being down
        // once produced 16,309 of these, each with a stack trace, which buried
        // everything else in the log; the state itself is harmless (a throw means
        // "unknown, look again next tick") so the flood was the only damage.
        const streak = (this.failureStreak.get(pairing.paneId) ?? 0) + 1;
        this.failureStreak.set(pairing.paneId, streak);
        const message = err instanceof Error ? err.message : String(err);
        if (streak === 1) {
          console.error(`[watcher] pairing ${pairing.key} check failed:`, message);
        } else if (streak % FAILURE_LOG_EVERY === 0) {
          console.error(`[watcher] pairing ${pairing.key} still failing (${streak} in a row): ${message}`);
        }
      }
    }
  }

  private async checkPairing(pairing: Pairing, forceRebaseline: boolean): Promise<void> {
    // Pairings written before cctag addressed panes by pane_id have no paneId at
    // all, so every herdr call for them resolves nothing and the thread has been
    // inert since the upgrade. Same outcome as a closed terminal — unpair and
    // say so — but diagnosed separately, because "the terminal was closed" is
    // both wrong and unactionable here, and because it keeps the reason out of
    // the log line as a literal `undefined`.
    if (!pairing.paneId) {
      this.pairingStore.remove(pairing.key);
      console.log(`[watcher] pairing ${pairing.key} predates pane-id addressing — unpaired`);
      await this.notifier
        .postReply(
          pairing.channel,
          pairing.threadTs ?? "",
          "⚠️ このスレッドのペアリングは古い形式のため利用できなくなっていました。" +
            "解除したので、`@cctag connect` で再接続してください。",
        )
        .catch((err) => console.error(`[watcher] could not report stale pairing ${pairing.key}:`, err));
      return;
    }

    const agent = await this.herdr.agentGet(pairing.paneId);
    if (!agent) {
      // "No agent" is not "no pane". Quitting the CLI to restart it in the same
      // pane leaves that pane at a shell prompt, and agent get then answers
      // agent_not_found — so unpairing on that alone tore down a pairing during
      // the very restart pane-id addressing exists to survive (pairing.ts).
      // Verified on a live pane: agent get failed while pane get still returned
      // it. A throw propagates, since a herdr timeout is not a missing pane.
      if (await this.herdr.paneExists(pairing.paneId)) {
        // Waited on, but not indefinitely. The grace period is what makes a
        // restart survivable; letting it run forever is what left threads
        // paired to panes whose agent was exited hours earlier.
        const since = this.agentlessPanes.get(pairing.paneId);
        this.watches.delete(pairing.paneId);
        if (since === undefined) {
          this.agentlessPanes.set(pairing.paneId, Date.now());
          console.log(`[watcher] pane ${pairing.paneId} has no agent running — keeping ${pairing.key} for now`);
          return;
        }
        if (Date.now() - since < this.agentlessGraceMs) return;

        // Long enough that this is an exited session, not one being restarted.
        const minutes = Math.max(1, Math.round(this.agentlessGraceMs / 60_000));
        await this.unpair(
          pairing,
          `pane ${pairing.paneId} had no agent for ${minutes}min — unpaired ${pairing.key}`,
          `⚠️ ペアリング先のエージェントが${minutes}分以上終了したままです（ターミナルは開いていますが、エージェントが動いていません）。` +
            "ペアリングを解除しました。`@cctag connect` で再接続してください。",
        );
        return;
      }

      // Closing the terminal used to be invisible from Slack: the thread stayed
      // paired and this returned quietly every 7s forever, so the only way to
      // discover it was to send a message and get startTurn's agent-not-found.
      // Reported once, from the same place that would have found the work.
      //
      // `null` specifically, never a thrown error: agentGet() returns null only
      // for herdr's own no-such-pane answer, and a herdr timeout must not be
      // reported as a closed terminal (tick() logs those). Same distinction the
      // poll loop makes.
      //
      // The pairing is dropped rather than kept, matching what a message to a
      // dead pane already does (commands.ts) — and a paneId is only unique
      // within a herdr run, so a kept pairing could later attach this thread to
      // whatever unrelated pane inherits the id.
      await this.unpair(
        pairing,
        `pane ${pairing.paneId} is gone — unpaired ${pairing.key}`,
        "⚠️ 接続先のインスタンスが見つかりません（ターミナルが閉じられた可能性があります）。" +
          "ペアリングを解除しました。`@cctag connect` で再接続してください。",
      );
      return;
    }
    this.agentlessPanes.delete(pairing.paneId);
    const driver = driverFor(agent.agent);

    const existing = this.watches.get(pairing.paneId);
    const sessionId = agent.sessionId ?? "";
    let sessionRotated = existing !== undefined && sessionId !== "" && sessionId !== existing.sessionId;

    // A session id is the cheap way to notice the CLI restarted, but not every
    // agent reports one — Codex routinely doesn't, which is exactly why both
    // drivers keep a cwd-based transcript fallback. Without a session id to
    // compare, rotation was undetectable: the watch held the transcript path
    // resolved on first sight forever, so after a restart in the same pane it
    // tailed a file nothing writes to any more and terminal-side responses
    // stopped appearing, silently and permanently.
    //
    // So when there's no id to compare — or no path yet, which is the same
    // problem seen from the other end — re-resolve and treat a different answer
    // as rotation. Only in those cases: a pane that does report an id keeps the
    // cheap comparison, and this walk opens transcript files to match on cwd.
    // True only for a transcript that did not exist when watching began, whose
    // every record therefore postdates it — see the offset choice below.
    let transcriptAppeared = false;
    if (existing !== undefined && !sessionRotated && (sessionId === "" || existing.transcriptPath === "")) {
      const resolved = driver.locateTranscript(agent.cwd, agent.sessionId) ?? "";
      if (resolved !== existing.transcriptPath) {
        sessionRotated = true;
        // Two guards on reading a newly-resolved transcript from the start.
        //
        // Not while resuming from a turn: TurnEngine has just reported that
        // transcript itself, and a Slack turn is what creates the first rollout
        // for a Codex pane — so this combination is the ordinary one, and reading
        // from 0 would repost the whole turn on the next settle.
        //
        // And only if the file was actually created after watching began. The
        // locators fold a failed readdir or first-line read into the same null as
        // "not there yet", so "no path, then a path" can equally mean one
        // unlucky resolution of a long-standing transcript.
        transcriptAppeared =
          existing.transcriptPath === "" &&
          resolved !== "" &&
          !forceRebaseline &&
          transcriptCreatedAfter(resolved, existing.startedAt);
      }
    }

    if (!existing || sessionRotated || forceRebaseline) {
      const tPath = driver.locateTranscript(agent.cwd, agent.sessionId) ?? "";
      this.watches.set(pairing.paneId, {
        sessionId,
        transcriptPath: tPath,
        // Normally the end of the file: on first sight, on resuming after a turn,
        // and on a restart, whatever is already written either predates watching
        // or was already reported, and replaying it would dump an old session
        // into the thread.
        //
        // The exception is a transcript that only just came into existence. Codex
        // creates its rollout file lazily — not at launch, but when a turn first
        // runs — so this is the ordinary case for it, and baselining at the end
        // would silently drop that entire first turn rather than a few seconds of
        // it. Nothing in the file can predate watching, so reading it whole is
        // both safe and the only way that turn reaches Slack.
        offset: tPath && !transcriptAppeared ? transcriptSizeSafe(tPath) : 0,
        startedAt: Date.now(),
        lastStatus: agent.agentStatus,
        collected: [],
        outboxBaseline: snapshotOutbox(agent.cwd),
        writes: new WrittenFileTracker(),
        settle: new SettleTracker(),
      });
      return;
    }

    const state = existing;
    if (state.transcriptPath) {
      const { records, newOffset } = await readNewRecords(state.transcriptPath, state.offset);
      state.offset = newOffset;
      const output = driver.extractTurnOutput(records);
      state.collected.push(...output.texts);
      // Tracked here, not only in TurnEngine: work that starts at the terminal
      // is only ever seen by this loop, and if it later blocks, the write it
      // already completed has to survive into the adopted turn.
      state.writes.ingest(output);
      state.settle.observe(output.lifecycle ?? []);
    }

    // herdr's status, corrected where the transcript contradicts a `working`
    // that will never clear (settle.ts). A pane stuck that way never reached
    // the settle check below, so terminal-side output was collected here and
    // then never posted.
    const status = state.settle.effectiveStatus(agent.agentStatus);

    if (status === "blocked") {
      // The watch is dropped only if the engine actually took the handoff. It
      // used to be deleted first, so an adoption refused because a Slack turn
      // claimed the pane in the meantime threw away this state — the assistant
      // text collected so far and the write tracking with it, which neither side
      // then reported.
      const adopted = await this.turnEngine.adoptBlockedTerminal(pairing, {
        driver,
        sessionId: state.sessionId,
        transcriptPath: state.transcriptPath,
        offset: state.offset,
        collected: state.collected,
        paneId: agent.paneId,
        cwd: agent.cwd,
        outboxBaseline: state.outboxBaseline,
        writes: state.writes,
      });
      if (adopted) this.watches.delete(pairing.paneId);
      return;
    }

    const wasActive = state.lastStatus === "working" || state.lastStatus === "blocked";
    const nowSettled = status === "idle" || status === "done";

    if (wasActive && nowSettled) {
      if (state.collected.length > 0) {
        const text = state.collected.join("\n\n").trim();
        if (text) {
          await postSegmented(
            this.notifier,
            pairing.channel,
            pairing.threadTs ?? "",
            text,
            "🖥️ ターミナル側で応答を検出しました:",
          );
        }
        state.collected = [];
      }
      // Outside the collected-text guard: work can produce a file without
      // producing assistant text (a chart written by a script, say), and that
      // file is still worth posting.
      //
      // Handed over and then forgotten, the same way `collected` is emptied and
      // `outboxBaseline` is advanced above. This state outlives a settle — it is
      // per watched pane, not per turn — and nothing used to clear the write
      // tracker, so every settle re-uploaded everything confirmed since the
      // watch began. Measured in a production thread: the oldest file posted 13
      // times, the next 6, the next 4. Forgotten only after the upload returns,
      // so a throw (caught by tick) leaves the files to be retried; the loop
      // awaits each pairing in turn, so nothing else can hand them over twice in
      // the meantime.
      const handedOver = state.writes.paths();
      state.outboxBaseline = await this.turnEngine.uploadOutboxAdditions(
        pairing,
        agent.cwd,
        state.outboxBaseline,
        handedOver,
      );
      state.writes.forget(handedOver);
    }

    // The corrected status, not herdr's: storing `working` for a pane the
    // transcript has already closed out would leave `wasActive` true forever,
    // so every later tick would re-report the same settle.
    state.lastStatus = status;
  }

  /**
   * Drops a pairing and tells the thread why, clearing every per-pane bit of
   * state with it.
   *
   * Shared by the two ways a pairing stops being usable — the pane closed, or
   * the pane outlived its agent by AGENTLESS_GRACE_MS — because forgetting one
   * of these maps is what leaves a watch running against a pane that no longer
   * has a pairing. The Slack post is best-effort: the local state must end up
   * consistent whether or not the thread can be reached.
   */
  private async unpair(pairing: Pairing, logLine: string, message: string): Promise<void> {
    this.pairingStore.remove(pairing.key);
    this.watches.delete(pairing.paneId);
    this.busyLastTick.delete(pairing.paneId);
    this.agentlessPanes.delete(pairing.paneId);
    this.failureStreak.delete(pairing.paneId);
    console.log(`[watcher] ${logLine}`);
    await this.notifier
      .postReply(pairing.channel, pairing.threadTs ?? "", message)
      .catch((err) => console.error(`[watcher] could not report ${pairing.paneId} unpaired:`, err));
  }
}
