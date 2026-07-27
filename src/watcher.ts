import type { HerdrClient } from "./herdr/client.js";
import type { Pairing, PairingStore } from "./pairing.js";
import type { TurnEngine } from "./turn.js";
import type { Notifier } from "./notifier.js";
import { snapshotOutbox, type DirSnapshot } from "./attachments.js";
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
    const agent = await this.herdr.agentGet(pairing.paneId);
    if (!agent) return;
    const driver = driverFor(agent.agent);

    const existing = this.watches.get(pairing.paneId);
    const sessionId = agent.sessionId ?? "";
    const sessionRotated = existing !== undefined && sessionId !== "" && sessionId !== existing.sessionId;

    if (!existing || sessionRotated || forceRebaseline) {
      const tPath = driver.locateTranscript(agent.cwd, agent.sessionId) ?? "";
      this.watches.set(pairing.paneId, {
        sessionId,
        transcriptPath: tPath,
        offset: tPath ? transcriptSizeSafe(tPath) : 0,
        lastStatus: agent.agentStatus,
        collected: [],
        outboxBaseline: snapshotOutbox(agent.cwd),
      });
      return; // never replay pre-existing history on first sight / resume / rotation
    }

    const state = existing;
    if (state.transcriptPath) {
      const { records, newOffset } = await readNewRecords(state.transcriptPath, state.offset);
      state.offset = newOffset;
      state.collected.push(...driver.extractTurnOutput(records).texts);
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
      });
      return;
    }

    const wasActive = state.lastStatus === "working" || state.lastStatus === "blocked";
    const nowSettled = agent.agentStatus === "idle" || agent.agentStatus === "done";

    if (wasActive && nowSettled) {
      if (state.collected.length > 0) {
        const text = state.collected.join("\n\n").trim();
        if (text) {
          const chunks = chunkForSlack(markdownToMrkdwn(text));
          for (const [i, chunk] of chunks.entries()) {
            const prefixed = i === 0 ? `🖥️ ターミナル側で応答を検出しました:\n${chunk}` : chunk;
            await this.notifier.postReply(pairing.channel, pairing.threadTs ?? "", prefixed);
          }
        }
        state.collected = [];
      }
      // Outside the collected-text guard: work can produce a file without
      // producing assistant text (a chart written by a script, say), and that
      // file is still worth posting.
      state.outboxBaseline = await this.turnEngine.uploadOutboxAdditions(pairing, agent.cwd, state.outboxBaseline);
    }

    state.lastStatus = agent.agentStatus;
  }
}
