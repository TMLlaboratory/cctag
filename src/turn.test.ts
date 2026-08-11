import { test } from "node:test";
import assert from "node:assert/strict";
import { TurnEngine } from "./turn.js";
import type { HerdrClient } from "./herdr/client.js";
import type { MessageHandle, Notifier } from "./notifier.js";
import type { Pairing } from "./pairing.js";
import type { AgentInfo } from "./herdr/types.js";
import { claudeDriver } from "./agents/claude/driver.js";
import { WrittenFileTracker } from "./attachments.js";

const PANE = "wT:p1";

const PERMISSION_PANE = [
  "Bash command",
  "",
  "  rm -rf build/",
  "",
  "Do you want to proceed?",
  "❯ 1. Yes",
  "  2. Yes, and don't ask again",
  "  3. No, and tell Claude what to do differently",
].join("\n");

function fakeAgent(agentStatus: AgentInfo["agentStatus"]): AgentInfo {
  return {
    agent: "claude",
    sessionId: "s1",
    agentStatus,
    cwd: "/tmp/nonexistent-cctag-test",
    terminalTitle: null,
    paneId: PANE,
    terminalId: "term_test",
    workspaceId: "wT",
  };
}

function fakePairing(): Pairing {
  return {
    key: `C1:1.1`,
    channel: "C1",
    threadTs: "1.1",
    paneId: PANE,
    terminalId: "term_test",
    cwd: "/tmp/nonexistent-cctag-test",
    pairedBy: "U1",
  } as Pairing;
}

/** Records every message posted, so a re-post shows up as a second entry. */
function fakeNotifier(): { notifier: Notifier; posts: string[] } {
  const posts: string[] = [];
  const handle: MessageHandle = { async update() {} };
  const notifier: Notifier = {
    async postReply(_c, _t, text) {
      posts.push(text);
    },
    async postMessage(_c, _t, text) {
      posts.push(text);
      return handle;
    },
  };
  return { notifier, posts };
}

function fakeHerdr(status: () => AgentInfo["agentStatus"]): HerdrClient {
  return {
    async agentGet() {
      return fakeAgent(status());
    },
    async paneRead() {
      return PERMISSION_PANE;
    },
    async agentSend() {},
  } as unknown as HerdrClient;
}

function engineFor(herdr: HerdrClient, notifier: Notifier, turnTimeoutMs: number): TurnEngine {
  return new TurnEngine(
    herdr,
    notifier,
    { turnTimeoutMs, pollIntervalMs: 5, limits: { maxFileBytes: 1024, maxFileCount: 1 } },
    { list: () => [fakePairing()] },
  );
}

function adopt(engine: TurnEngine, pairing: Pairing): Promise<void> {
  return engine.adoptBlockedTerminal(pairing, {
    driver: claudeDriver,
    sessionId: "s1",
    transcriptPath: "",
    offset: 0,
    collected: [],
    paneId: PANE,
    cwd: "/tmp/nonexistent-cctag-test",
    outboxBaseline: {},
    writes: new WrittenFileTracker(),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

test("an unanswered prompt is posted once and does not time out, however long it sits", async () => {
  // The reported failure: leaving a permission request alone produced repeated
  // Slack notifications. The turn timed out on schedule, which freed the pane,
  // and BackgroundWatcher re-adopted the still-blocked pane and posted the same
  // prompt again — once per timeout window, indefinitely.
  const { notifier, posts } = fakeNotifier();
  const engine = engineFor(
    fakeHerdr(() => "blocked"),
    notifier,
    30, // a timeout this short would have fired many times over the wait below
  );
  const pairing = fakePairing();

  await adopt(engine, pairing);
  // Long enough to get past the second poll: once a prompt is up the loop
  // slows to a 5s floor (see pollLoop's `interval`), and the timeout is only
  // re-checked on the poll after that. Before the fix, that poll is where the
  // turn died and freed the pane for the watcher to re-adopt.
  await sleep(5_600);

  const permissionPosts = posts.filter((p) => p.includes("許可リクエスト"));
  assert.equal(permissionPosts.length, 1, `prompt should be posted once, got ${permissionPosts.length}`);
  assert.equal(
    posts.filter((p) => p.includes("タイムアウト")).length,
    0,
    "a prompt waiting on a human is not a stalled turn",
  );
  assert.equal(engine.isBusy(PANE), true, "the pane must stay busy so the watcher cannot re-adopt it");

  await engine.abortTurn(PANE);
});

test("the timeout still fires when the agent itself stops making progress", async () => {
  // The deadline refresh is scoped to blocked panes: a pane stuck `working`
  // must still time out, or the guard above would disable the timeout entirely.
  const { notifier, posts } = fakeNotifier();
  const engine = engineFor(
    fakeHerdr(() => "working"),
    notifier,
    30,
  );

  await adopt(engine, fakePairing());
  await sleep(300);

  assert.equal(
    posts.filter((p) => p.includes("タイムアウト")).length,
    1,
    "a working pane that never settles should time out exactly once",
  );
  assert.equal(engine.isBusy(PANE), false, "a timed-out turn releases the pane");
});
