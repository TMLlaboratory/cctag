import type { HerdrClient } from "./herdr/client.js";
import type { Pairing, PairingStore } from "./pairing.js";
import type { TurnEngine } from "./turn.js";
import type { Notifier } from "./notifier.js";
import { snapshotOutbox, WrittenFileTracker, type DirSnapshot } from "./attachments.js";
import { postSegmented } from "./slack/post.js";
import { readNewRecords, transcriptSizeSafe } from "./agents/transcript.js";
import { driverFor } from "./agents/driver.js";
import { chunkForSlack, markdownToMrkdwn } from "./slack/mrkdwn.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface WatchState {
  sessionId: string;
  transcriptPath: string;
  offset: number;
  lastStatus: string;
  collected: string[];
  /** `<cwd>/.cctag/outbox` as of the last report, so terminal-initiated work
   *  gets its files attached too — see TurnEngine.uploadOutboxAdditions. */
  outboxBaseline: DirSnapshot;
  /** Write tracking for terminal-initiated work, kept here so it survives to
   *  the report (or to the handoff, if the terminal blocks first). */
  writes: WrittenFileTracker;
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
export class BackgroundWatcher {
  private watches = new Map<string, WatchState>(); // key: paneId
  private busyLastTick = new Set<string>();

  private running = false;

  constructor(
    private readonly herdr: HerdrClient,
    private readonly pairingStore: PairingStore,
    private readonly turnEngine: TurnEngine,
    private readonly notifier: Notifier,
    private readonly intervalMs = 7_000,
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
      }
    }

    for (const pairing of pairings) {
      if (this.turnEngine.isBusy(pairing.paneId)) {
        this.busyLastTick.add(pairing.paneId);
        continue;
      }
      const resumingFromActiveTurn = this.busyLastTick.delete(pairing.paneId);
      await this.checkPairing(pairing, resumingFromActiveTurn).catch((err) =>
        console.error(`[watcher] pairing ${pairing.key} check failed:`, err),
      );
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
      this.pairingStore.remove(pairing.key);
      this.watches.delete(pairing.paneId);
      this.busyLastTick.delete(pairing.paneId);
      console.log(`[watcher] pane ${pairing.paneId} is gone — unpaired ${pairing.key}`);
      await this.notifier
        .postReply(
          pairing.channel,
          pairing.threadTs ?? "",
          "⚠️ 接続先のインスタンスが見つかりません（ターミナルが閉じられた可能性があります）。" +
            "ペアリングを解除しました。`@cctag connect` で再接続してください。",
        )
        .catch((err) => console.error(`[watcher] could not report ${pairing.paneId} gone:`, err));
      return;
    }
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
        transcriptAppeared = existing.transcriptPath === "" && resolved !== "";
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
        lastStatus: agent.agentStatus,
        collected: [],
        outboxBaseline: snapshotOutbox(agent.cwd),
        writes: new WrittenFileTracker(),
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
    }

    if (agent.agentStatus === "blocked") {
      this.watches.delete(pairing.paneId);
      await this.turnEngine.adoptBlockedTerminal(pairing, {
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
      return;
    }

    const wasActive = state.lastStatus === "working" || state.lastStatus === "blocked";
    const nowSettled = agent.agentStatus === "idle" || agent.agentStatus === "done";

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
      state.outboxBaseline = await this.turnEngine.uploadOutboxAdditions(
        pairing,
        agent.cwd,
        state.outboxBaseline,
        state.writes.paths(),
      );
    }

    state.lastStatus = agent.agentStatus;
  }
}
