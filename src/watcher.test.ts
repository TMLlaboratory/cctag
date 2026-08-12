import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { BackgroundWatcher } from "./watcher.js";
import { PairingStore, type Pairing } from "./pairing.js";
import type { HerdrClient } from "./herdr/client.js";
import type { AgentInfo } from "./herdr/types.js";
import type { MessageHandle, Notifier } from "./notifier.js";
import type { TurnEngine } from "./turn.js";
import { encodeCwd } from "./agents/claude/transcript.js";

const PANE = "wG:p1";

function fakeAgent(): AgentInfo {
  return {
    agent: "claude",
    sessionId: "s1",
    agentStatus: "idle",
    cwd: "/tmp/nonexistent-cctag-test",
    terminalTitle: null,
    paneId: PANE,
    terminalId: "term_gone",
    workspaceId: "wG",
  };
}

function fakePairing(): Pairing {
  return {
    key: "C1:1.1",
    channel: "C1",
    threadTs: "1.1",
    paneId: PANE,
    terminalId: "term_gone",
    cwd: "/tmp/nonexistent-cctag-test",
    pairedBy: "U1",
  } as Pairing;
}

function fakeNotifier(): { notifier: Notifier; replies: string[] } {
  const replies: string[] = [];
  const handle: MessageHandle = { async update() {} };
  const notifier: Notifier = {
    async postReply(_c, _t, text) {
      replies.push(text);
    },
    async postMessage(_c, _t, text) {
      replies.push(text);
      return handle;
    },
  };
  return { notifier, replies };
}

/** A TurnEngine stand-in: nothing is ever busy, so every tick reaches checkPairing. */
const idleEngine = { isBusy: () => false } as unknown as TurnEngine;

function storeWithPairing(dir: string): PairingStore {
  const store = new PairingStore(join(dir, "pairings.json"));
  store.add(fakePairing());
  return store;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

test("a pane that has gone away is reported once and unpaired", async () => {
  // Closing the terminal used to be undetectable from Slack: the watcher
  // returned quietly on every tick and the pairing stayed, so the only way to
  // find out was to send a message and have startTurn fail.
  const dir = mkdtempSync(join(tmpdir(), "cctag-watcher-"));
  try {
    const store = storeWithPairing(dir);
    const { notifier, replies } = fakeNotifier();
    const herdr = {
      async agentGet() {
        return null; // herdr's own "no such pane"
      },
    } as unknown as HerdrClient;

    const watcher = new BackgroundWatcher(herdr, store, idleEngine, notifier, 20);
    watcher.start();
    await sleep(150); // several ticks
    watcher.stop();

    const notices = replies.filter((r) => r.includes("インスタンスが見つかりません"));
    assert.equal(notices.length, 1, `reported exactly once, got ${notices.length}`);
    assert.equal(store.list().length, 0, "the dead pairing must not linger");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a herdr error is not reported as a closed terminal", async () => {
  // The distinction that matters: agentGet() returns null only for herdr's own
  // no-such-pane answer, and throws for a timeout or spawn failure. Treating the
  // second as a closed terminal would unpair a live thread whenever herdr
  // hiccuped — e.g. while it restarts after a Homebrew update.
  const dir = mkdtempSync(join(tmpdir(), "cctag-watcher-"));
  try {
    const store = storeWithPairing(dir);
    const { notifier, replies } = fakeNotifier();
    const herdr = {
      async agentGet(): Promise<never> {
        throw new Error("herdr command timed out");
      },
    } as unknown as HerdrClient;

    const watcher = new BackgroundWatcher(herdr, store, idleEngine, notifier, 20);
    watcher.start();
    await sleep(150);
    watcher.stop();

    assert.equal(replies.length, 0, "nothing should be posted for a transient failure");
    assert.equal(store.list().length, 1, "the pairing must survive a herdr hiccup");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a pairing from before pane-id addressing is diagnosed as stale, not as a closed terminal", async () => {
  // Observed in production right after deploying the check above: three such
  // pairings existed and logged "pane undefined is gone". They do need clearing
  // — nothing can resolve them — but "the terminal was closed" is the wrong
  // reason to give someone, and it never reaches herdr to find that out.
  const dir = mkdtempSync(join(tmpdir(), "cctag-watcher-"));
  try {
    const store = new PairingStore(join(dir, "pairings.json"));
    store.add({ ...fakePairing(), paneId: undefined as unknown as string });
    const { notifier, replies } = fakeNotifier();
    let queried = 0;
    const herdr = {
      async agentGet() {
        queried += 1;
        return null;
      },
    } as unknown as HerdrClient;

    const watcher = new BackgroundWatcher(herdr, store, idleEngine, notifier, 20);
    watcher.start();
    await sleep(150);
    watcher.stop();

    assert.equal(replies.length, 1, "reported once");
    assert.match(replies[0], /古い形式/);
    assert.equal(queried, 0, "no point asking herdr about a target it cannot resolve");
    assert.equal(store.list().length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- transcript rotation, for agents that report no session id -------------
// These drive the real Claude driver (its cwd-based fallback is the same shape
// as Codex's, which is the agent that actually omits session ids) so the
// locate-fallback participates rather than being mocked out.

function transcriptDirFor(cwd: string): string {
  return join(homedir(), ".claude", "projects", encodeCwd(cwd));
}

function writeTranscript(dir: string, name: string, texts: string[]): void {
  mkdirSync(dir, { recursive: true });
  const lines = texts.map((t) =>
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: t }] } }),
  );
  writeFileSync(join(dir, name), lines.join("\n") + "\n");
}

/** A pane reporting no session id, whose status the test can flip. */
function rotatingHerdr(cwd: string, status: () => AgentInfo["agentStatus"]): HerdrClient {
  return {
    async agentGet() {
      return { ...fakeAgent(), sessionId: null, cwd, agentStatus: status() };
    },
  } as unknown as HerdrClient;
}

async function withRotationFixture(
  run: (ctx: {
    cwd: string;
    tDir: string;
    store: PairingStore;
    replies: string[];
    setStatus: (s: AgentInfo["agentStatus"]) => void;
    start: () => BackgroundWatcher;
  }) => Promise<void>,
): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), "cctag-rot-"));
  const tDir = transcriptDirFor(cwd);
  const storeDir = mkdtempSync(join(tmpdir(), "cctag-rot-store-"));
  let status: AgentInfo["agentStatus"] = "working";
  let watcher: BackgroundWatcher | undefined;
  try {
    const store = new PairingStore(join(storeDir, "pairings.json"));
    store.add({ ...fakePairing(), cwd });
    const { notifier, replies } = fakeNotifier();
    await run({
      cwd,
      tDir,
      store,
      replies,
      setStatus: (s) => (status = s),
      start: () => {
        watcher = new BackgroundWatcher(
          rotatingHerdr(cwd, () => status),
          store,
          idleEngine,
          notifier,
          20,
        );
        watcher.start();
        return watcher;
      },
    });
  } finally {
    watcher?.stop();
    rmSync(tDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(storeDir, { recursive: true, force: true });
  }
}

test("a transcript that appears after watching began is read whole, not skipped", async () => {
  // Codex creates its rollout file when a turn first runs, not at launch, so at
  // first sight there is nothing to resolve. The watch recorded "" and, with no
  // session id to compare, never looked again — the file stayed untailed for the
  // life of the pairing and that first turn never reached Slack.
  await withRotationFixture(async ({ tDir, replies, setStatus, start }) => {
    start();
    await sleep(80); // first sight: no transcript exists yet

    writeTranscript(tDir, "session-a.jsonl", ["ターミナル側の最初の応答"]);
    await sleep(120); // notice it, then tail it
    setStatus("idle"); // settling is what triggers the report
    await sleep(120);

    assert.ok(
      replies.some((r) => r.includes("ターミナル側の最初の応答")),
      `the first turn should have been reported, got ${JSON.stringify(replies)}`,
    );
  });
});

test("the CLI restarting in the same pane switches to the new transcript", async () => {
  // The rotation case proper: with no session id, the old path was kept forever,
  // so everything the restarted CLI produced was tailed from a file nothing
  // writes to any more.
  await withRotationFixture(async ({ tDir, replies, setStatus, start }) => {
    writeTranscript(tDir, "session-a.jsonl", ["古いセッションの発言"]);
    start();
    await sleep(80); // first sight baselines at the end of session-a

    // A restart: a newer transcript, which the cwd fallback resolves to instead.
    writeTranscript(tDir, "session-b.jsonl", ["新しいセッションの発言"]);
    await sleep(120);
    // Written after rotation was noticed, so it must be tailed from session-b.
    writeTranscript(tDir, "session-b.jsonl", ["新しいセッションの発言", "再起動後の応答"]);
    await sleep(120);
    setStatus("idle");
    await sleep(120);

    assert.ok(
      replies.some((r) => r.includes("再起動後の応答")),
      `output after the restart should be reported, got ${JSON.stringify(replies)}`,
    );
    assert.ok(
      !replies.some((r) => r.includes("古いセッションの発言")),
      "the pre-existing session must not be replayed",
    );
  });
});

test("a transcript that already existed is still never replayed", async () => {
  // The false-positive side: re-resolving must not turn into dumping history
  // into the thread, which is the invariant this watcher is built around.
  await withRotationFixture(async ({ tDir, replies, setStatus, start }) => {
    writeTranscript(tDir, "session-a.jsonl", ["ずっと前の発言", "これも前の発言"]);
    start();
    await sleep(150);
    setStatus("idle");
    await sleep(120);

    assert.equal(
      replies.filter((r) => r.includes("前の発言")).length,
      0,
      `history must not be replayed, got ${JSON.stringify(replies)}`,
    );
  });
});
