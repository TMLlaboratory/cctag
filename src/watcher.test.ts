import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackgroundWatcher } from "./watcher.js";
import { PairingStore, type Pairing } from "./pairing.js";
import type { HerdrClient } from "./herdr/client.js";
import type { MessageHandle, Notifier } from "./notifier.js";
import type { TurnEngine } from "./turn.js";

const PANE = "wG:p1";

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
