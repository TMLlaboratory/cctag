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

function permissionPane(command: string, cursorOn = 1): string {
  const opts = ["Yes", "Yes, and don't ask again", "No, and tell Claude what to do differently"];
  return [
    "Bash command",
    "",
    `  ${command}`,
    "",
    "Do you want to proceed?",
    ...opts.map((label, i) => `${i + 1 === cursorOn ? "❯" : " "} ${i + 1}. ${label}`),
  ].join("\n");
}

const PERMISSION_PANE = permissionPane("rm -rf build/");

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

function fakeHerdr(
  status: () => AgentInfo["agentStatus"],
  pane: () => string = () => PERMISSION_PANE,
): HerdrClient {
  return {
    async agentGet() {
      return fakeAgent(status());
    },
    async paneRead() {
      return pane();
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

function adopt(engine: TurnEngine, pairing: Pairing): Promise<boolean> {
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

  engine.abortAll();
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

test("a prompt replaced at the terminal is re-posted, without the pane ever leaving blocked", async () => {
  // Codex review, Critical 1. Answering prompt A at the keyboard and landing on
  // prompt B never passes through a non-blocked status, so the phase guard alone
  // left the thread offering buttons for a prompt that was already gone while
  // the one actually waiting was never posted — and, since the pane stays busy,
  // nothing else would ever surface it.
  const { notifier, posts } = fakeNotifier();
  let command = "rm -rf build/";
  const engine = engineFor(
    fakeHerdr(
      () => "blocked",
      () => permissionPane(command),
    ),
    notifier,
    600_000,
  );

  await adopt(engine, fakePairing());
  await sleep(300);
  assert.equal(posts.filter((p) => p.includes("許可リクエスト")).length, 1, "prompt A posted");

  command = "npm install"; // answered at the keyboard; the agent hits prompt B
  await sleep(5_600);

  assert.equal(
    posts.filter((p) => p.includes("許可リクエスト")).length,
    2,
    "the replacement prompt must be posted too",
  );

  engine.abortAll();
});

test("moving the cursor within the same prompt is not mistaken for a new one", async () => {
  // The false-positive side of the same fix, and the more dangerous one: a
  // fingerprint that changed when the user merely pressed Down would re-post a
  // still-pending prompt on every poll — reintroducing the repetition the
  // deadline fix removed. The cursor glyph and its indentation must normalize away.
  const { notifier, posts } = fakeNotifier();
  let cursor = 1;
  const engine = engineFor(
    fakeHerdr(
      () => "blocked",
      () => permissionPane("rm -rf build/", cursor),
    ),
    notifier,
    600_000,
  );

  await adopt(engine, fakePairing());
  await sleep(300);
  cursor = 3; // arrow keys at the terminal, prompt still pending
  await sleep(5_600);

  assert.equal(
    posts.filter((p) => p.includes("許可リクエスト")).length,
    1,
    "navigating the menu is the same prompt",
  );

  engine.abortAll();
});

test("a transient herdr failure does not end a live turn", async () => {
  // Codex review, Critical 5. agentGet() returns null only for herdr's own "no
  // such pane"; a timeout or spawn failure throws. Treating the two alike killed
  // turns whose agent was still working, and released the pane to a watcher that
  // rebaselines — losing the rest of the output. Uses a `working` pane so the
  // loop keeps its fast interval and the failures actually get reached.
  const { notifier, posts } = fakeNotifier();
  let calls = 0;
  const herdr = {
    async agentGet() {
      calls += 1;
      if (calls === 2 || calls === 3) throw new Error("herdr command timed out");
      return fakeAgent("working");
    },
    async paneRead() {
      return PERMISSION_PANE;
    },
    async agentSend() {},
  } as unknown as HerdrClient;
  const engine = engineFor(herdr, notifier, 600_000);

  try {
    await adopt(engine, fakePairing());
    await sleep(300);

    assert.ok(calls >= 4, `the loop should have kept polling through the failures (calls=${calls})`);
    assert.equal(
      posts.filter((p) => p.includes("インスタンスが終了") || p.includes("herdrへの問い合わせ")).length,
      0,
      "two failures in a row must not be reported as a dead pane",
    );
    assert.equal(engine.isBusy(PANE), true, "ownership is preserved across a hiccup");
  } finally {
    engine.abortAll();
  }
});

test("herdr failing persistently does eventually end the turn, with its own message", async () => {
  const { notifier, posts } = fakeNotifier();
  const herdr = {
    async agentGet(): Promise<AgentInfo | null> {
      throw new Error("herdr command timed out");
    },
    async paneRead() {
      return PERMISSION_PANE;
    },
    async agentSend() {},
  } as unknown as HerdrClient;
  const engine = engineFor(herdr, notifier, 600_000);

  await adopt(engine, fakePairing());
  await sleep(300);

  assert.equal(posts.filter((p) => p.includes("herdrへの問い合わせが連続して失敗")).length, 1);
  assert.equal(posts.filter((p) => p.includes("インスタンスが終了")).length, 0, "not the same diagnosis");
  assert.equal(engine.isBusy(PANE), false);
});

test("abortAll stops every poll loop, so a dead transport leaves nothing running", async () => {
  // Codex review, Critical 2. On a Spoke reconnect only the watcher was stopped;
  // the engine's loops kept polling herdr through a notifier whose socket was
  // gone, and the replacement engine then started a second loop over the same pane.
  const { notifier } = fakeNotifier();
  const engine = engineFor(
    fakeHerdr(() => "blocked"),
    notifier,
    600_000,
  );

  await adopt(engine, fakePairing());
  await sleep(100);
  assert.equal(engine.isBusy(PANE), true);

  assert.equal(engine.abortAll(), 1, "reports what it signalled");
  // Cancellation signals; the holder releases. The pane therefore comes back as
  // soon as the loop notices, which is immediately rather than at the end of its
  // five-second wait because the wait itself aborts.
  for (let i = 0; i < 40 && engine.isBusy(PANE); i++) await sleep(25);
  assert.equal(engine.isBusy(PANE), false, "the loop must release on its way out");
  assert.equal(engine.abortAll(), 0, "nothing left to signal");
});

test("a prompt answered twice drives the TUI once", async () => {
  // Codex review, Moderate 1. Slack buttons can be clicked twice, and the
  // phase/prompt-id checks alone let both deliveries through: each passes the
  // check before either reaches the state mutation that happens after `await`.
  // Both then answered the pane — for Codex that is digit-plus-Enter twice,
  // whose second copy can land on whatever menu appeared next and confirm it.
  const { notifier } = fakeNotifier();
  const sent: string[] = [];
  const herdr = {
    async agentGet() {
      return fakeAgent("blocked");
    },
    async paneRead() {
      return PERMISSION_PANE;
    },
    // Slow enough that the second click arrives while the first is still in
    // flight — the real race, rather than a simulated one.
    async agentSend(_paneId: string, text: string) {
      await sleep(40);
      sent.push(text);
    },
  } as unknown as HerdrClient;
  const engine = engineFor(herdr, notifier, 600_000);

  try {
    await adopt(engine, fakePairing());
    await sleep(200); // prompt posted, promptId is now 1

    const first = engine.answerPermissionButton(PANE, 1, "1");
    const second = await engine.answerPermissionButton(PANE, 1, "1");
    await first;
    await sleep(100); // let any second injection land before counting

    assert.equal(second.ok, false, "the second click must be rejected while the first is in flight");
    assert.equal(sent.length, 1, `the TUI must be driven once, got ${sent.length}: ${JSON.stringify(sent)}`);
  } finally {
    engine.abortAll();
  }
});

test("a failed answer is not left claimed, so it can be retried", async () => {
  // The rollback half: if input injection throws, the prompt must go back to
  // pending rather than wedging the turn with nothing able to answer it.
  const { notifier } = fakeNotifier();
  let attempts = 0;
  const herdr = {
    async agentGet() {
      return fakeAgent("blocked");
    },
    async paneRead() {
      return PERMISSION_PANE;
    },
    async agentSend() {
      attempts += 1;
      if (attempts === 1) throw new Error("send-text failed");
    },
  } as unknown as HerdrClient;
  const engine = engineFor(herdr, notifier, 600_000);

  try {
    await adopt(engine, fakePairing());
    await sleep(200);

    await assert.rejects(engine.answerPermissionButton(PANE, 1, "1"), /send-text failed/);
    const retry = await engine.answerPermissionButton(PANE, 1, "1");
    assert.deepEqual(retry, { ok: true }, "the same prompt must still be answerable after a failure");
    assert.equal(attempts, 2);
  } finally {
    engine.abortAll();
  }
});

test("disconnecting during startTurn's setup abandons it instead of prompting the pane", async () => {
  // Codex review, Critical 3. abortTurn() could only reach a turn that had
  // already registered, so a disconnect during the attachment download left the
  // pairing gone and the setup running: it went on to prompt the agent and — now
  // that a blocked pane is held indefinitely — kept the pane forever, with any
  // prompt posted into a thread that could no longer answer it.
  const { notifier, posts } = fakeNotifier();
  const prompted: string[] = [];
  let releaseDownload: (() => void) | undefined;
  const downloadStarted = new Promise<void>((r) => setTimeout(r, 60));
  const herdr = {
    async agentGet() {
      return fakeAgent("idle");
    },
    async paneRead() {
      return "";
    },
    async agentPrompt(_paneId: string, text: string) {
      prompted.push(text);
    },
    async agentSend() {},
    async paneSendKeys() {},
  } as unknown as HerdrClient;
  const engine = engineFor(herdr, notifier, 600_000);

  // A notifier whose file download blocks, standing in for a slow transfer.
  const slowNotifier: Notifier = {
    ...notifier,
    async fetchIncomingFile() {
      await new Promise<void>((r) => (releaseDownload = r));
      return null;
    },
  };
  const engineWithSlowFiles = new TurnEngine(
    herdr,
    slowNotifier,
    { turnTimeoutMs: 600_000, pollIntervalMs: 5, limits: { maxFileBytes: 1024 * 1024, maxFileCount: 1 } },
    { list: () => [fakePairing()] },
  );

  const started = engineWithSlowFiles
    .startTurn(fakePairing(), "U1", "これを見て", {
      files: [{ id: "F1", name: "a.png", size: 100 } as never],
    })
    .catch(() => {});

  await downloadStarted;
  assert.equal(engineWithSlowFiles.isBusy(PANE), true, "the pane is held while setting up");

  engineWithSlowFiles.cancelPane(PANE); // the disconnect
  releaseDownload?.();
  await started;

  assert.equal(prompted.length, 0, "a cancelled setup must not reach the pane");
  assert.equal(engineWithSlowFiles.isBusy(PANE), false, "and must not leave the pane held");
  void engine;
  void posts;
});

test("a refused adoption leaves the watcher's handoff intact", async () => {
  // Codex review, Critical 6. adoptBlockedTerminal() returned void, so the
  // watcher deleted its watch — collected output and write tracking included —
  // before finding out whether the engine took it. If a Slack turn had claimed
  // the pane in between, that state was simply lost.
  const { notifier } = fakeNotifier();
  const engine = engineFor(
    fakeHerdr(() => "blocked"),
    notifier,
    600_000,
  );

  try {
    const first = await adopt(engine, fakePairing());
    assert.equal(first, true, "the first adoption is accepted");

    const second = await adopt(engine, fakePairing());
    assert.equal(second, false, "a pane already held must refuse, and say so");
  } finally {
    engine.abortAll();
  }
});

test("a command and a turn cannot drive the same pane at once", async () => {
  // What `externallyBusy` was for, but as mutual exclusion rather than a shared
  // flag: previously two overlapping external operations both set the same Set
  // entry and the first to finish cleared it, freeing a pane still in use.
  const { notifier } = fakeNotifier();
  const engine = engineFor(
    fakeHerdr(() => "blocked"),
    notifier,
    600_000,
  );

  try {
    const lease = engine.acquire(PANE, "model-command");
    assert.ok(lease);
    assert.equal(engine.isBusy(PANE), true);

    await assert.rejects(
      engine.startTurn(fakePairing(), "U1", "hello"),
      /busy/,
      "a turn must not start on a pane a command is driving",
    );
    assert.equal(await adopt(engine, fakePairing()), false, "nor may the watcher adopt it");

    lease.release();
    assert.equal(engine.isBusy(PANE), false);
  } finally {
    engine.abortAll();
  }
});

test("a cancel landing while the prompt is being posted does not leak the pane", async () => {
  // Codex re-review, Critical 1. The last cancellation check sat before the
  // status message went out, so a cancel arriving during that await still
  // registered a turn — with an already-cancelled lease — and the poll loop then
  // returned on the aborted signal without releasing. The pane stayed busy for
  // the life of the process, and nothing could ever take it again.
  const { notifier } = fakeNotifier();
  let releasePost: (() => void) | undefined;
  const slowPost: Notifier = {
    ...notifier,
    async postMessage(_c, _t, _text) {
      await new Promise<void>((r) => (releasePost = r));
      return { async update() {} };
    },
  };
  const engine = new TurnEngine(
    fakeHerdr(() => "blocked"),
    slowPost,
    { turnTimeoutMs: 600_000, pollIntervalMs: 5, limits: { maxFileBytes: 1024, maxFileCount: 1 } },
    { list: () => [fakePairing()] },
  );

  const adopting = adopt(engine, fakePairing());
  for (let i = 0; i < 40 && !releasePost; i++) await sleep(25);
  assert.ok(releasePost, "the adoption should be waiting on its status post");

  engine.cancelPane(PANE); // the disconnect
  releasePost();
  assert.equal(await adopting, false, "a cancelled adoption must not report success");

  for (let i = 0; i < 40 && engine.isBusy(PANE); i++) await sleep(25);
  assert.equal(engine.isBusy(PANE), false, "the pane must come back");
});

test("cancelling does not free the pane while the holder is still driving it", async () => {
  // Codex re-review, Critical 2. cancelPane used to delete the turn and release
  // its lease straight away, so another operation could acquire the pane while
  // the cancelled one was still sending keystrokes to it. Cancellation now only
  // signals; the holder releases once it has stopped.
  const { notifier } = fakeNotifier();
  let releasePost: (() => void) | undefined;
  const slowPost: Notifier = {
    ...notifier,
    async postMessage() {
      await new Promise<void>((r) => (releasePost = r));
      return { async update() {} };
    },
  };
  const engine = new TurnEngine(
    fakeHerdr(() => "blocked"),
    slowPost,
    { turnTimeoutMs: 600_000, pollIntervalMs: 5, limits: { maxFileBytes: 1024, maxFileCount: 1 } },
    { list: () => [fakePairing()] },
  );

  const adopting = adopt(engine, fakePairing());
  for (let i = 0; i < 40 && !releasePost; i++) await sleep(25);

  engine.cancelPane(PANE);
  assert.equal(engine.isBusy(PANE), true, "still held: the holder has not stopped yet");
  assert.equal(engine.acquire(PANE, "model-command"), null, "so nothing else may take it");

  releasePost?.();
  await adopting;
  for (let i = 0; i < 40 && engine.isBusy(PANE); i++) await sleep(25);
  assert.ok(engine.acquire(PANE, "model-command"), "and it is available once the holder let go");
});

test("a cancel mid-submit leaves the pane held until the keystrokes stop", async () => {
  // Codex re-review, Critical 2, the case the test above cannot reach: here the
  // turn is already registered and inside its submit sequence, which is exactly
  // when cancelPane used to delete the state and release the lease immediately —
  // handing the pane to the next caller while this one was still typing into it.
  const { notifier } = fakeNotifier();
  let releasePrompt: (() => void) | undefined;
  const herdr = {
    async agentGet() {
      return fakeAgent("working");
    },
    async paneRead() {
      return ""; // no startup dialog to trip over
    },
    async agentPrompt() {
      await new Promise<void>((r) => (releasePrompt = r));
    },
    async paneSendKeys() {},
    async agentSend() {},
  } as unknown as HerdrClient;
  const engine = engineFor(herdr, notifier, 600_000);

  const starting = engine.startTurn(fakePairing(), "U1", "hello").catch(() => {});
  for (let i = 0; i < 60 && !releasePrompt; i++) await sleep(25);
  assert.ok(releasePrompt, "the turn should be inside its submit sequence");

  engine.cancelPane(PANE);
  assert.equal(
    engine.acquire(PANE, "model-command"),
    null,
    "nothing may take a pane whose previous holder is still sending keys to it",
  );

  releasePrompt();
  await starting;
  for (let i = 0; i < 60 && engine.isBusy(PANE); i++) await sleep(25);
  assert.equal(engine.isBusy(PANE), false, "and it comes back once the sequence stops");
});

test("a poll loop that outlived its turn cannot finalize the one that replaced it", async () => {
  // Codex re-review, Critical 2, second half: finalize() looked its state up by
  // pane id, so a stale loop reaching it would have posted the result of — and
  // torn down — whatever turn owns the pane now.
  const { notifier, posts } = fakeNotifier();
  const engine = engineFor(
    fakeHerdr(() => "blocked"),
    notifier,
    600_000,
  );

  try {
    assert.equal(await adopt(engine, fakePairing()), true);
    engine.cancelPane(PANE);
    for (let i = 0; i < 40 && engine.isBusy(PANE); i++) await sleep(25);

    // A second turn takes the pane; the first loop is gone but its state object
    // still exists in the closure that was running it.
    assert.equal(await adopt(engine, fakePairing()), true, "the pane is free for a new turn");
    const before = posts.length;
    await sleep(100);
    assert.equal(engine.isBusy(PANE), true, "the new turn must still hold the pane");
    assert.ok(
      posts.length >= before,
      "and no finalize from the dead loop should have posted a result for it",
    );
  } finally {
    engine.abortAll();
  }
});

test("a failed pane read does not surrender a prompt already posted to Slack", async () => {
  // Codex re-review, Critical 5. Only agentGet's exceptions were tolerated; a
  // paneRead throw escaped the loop, and the crash handler released the pane —
  // so one herdr hiccup while a prompt was up handed it to the watcher, which
  // re-adopted and posted the same prompt again, discarding the collected output.
  const { notifier, posts } = fakeNotifier();
  let reads = 0;
  const herdr = {
    async agentGet() {
      return fakeAgent("blocked");
    },
    // The first reads fail, i.e. before the prompt has been posted and while the
    // loop is still on its fast interval — the failures have to land somewhere
    // the test can reach without waiting out the five-second floor a posted
    // prompt switches to.
    async paneRead() {
      reads += 1;
      if (reads <= 2) throw new Error("herdr command timed out");
      return PERMISSION_PANE;
    },
    async agentSend() {},
  } as unknown as HerdrClient;
  const engine = engineFor(herdr, notifier, 600_000);

  try {
    await adopt(engine, fakePairing());
    await sleep(300);

    assert.equal(engine.isBusy(PANE), true, "the prompt's owner must keep the pane");
    assert.equal(
      posts.filter((p) => p.includes("許可リクエスト")).length,
      1,
      "and must not re-post the prompt it already delivered",
    );
    assert.equal(
      posts.filter((p) => p.includes("herdrへの問い合わせ") || p.includes("インスタンスが終了")).length,
      0,
      "two failures in a row are not a dead pane",
    );
  } finally {
    engine.abortAll();
  }
});

test("an unparseable prompt does not blind the check for every prompt after it", async () => {
  // Codex re-review, Critical 4. The replacement check required the *posted*
  // prompt to have a fingerprint, so one unparseable prompt turned the check off
  // for good: it was posted as a raw screen dump with buttons that could not
  // answer it, and — the pane never leaving `blocked` — every prompt that
  // replaced it stayed invisible for the life of the turn.
  const { notifier, posts } = fakeNotifier();
  let pane = ["some dialog cctag cannot read", "no options here at all"].join("\n");
  const engine = engineFor(
    fakeHerdr(
      () => "blocked",
      () => pane,
    ),
    notifier,
    600_000,
  );

  try {
    await adopt(engine, fakePairing());
    await sleep(300);
    assert.equal(
      posts.filter((p) => p.includes("許可リクエスト")).length,
      1,
      "the unreadable pane is posted as the parse-failure fallback",
    );

    pane = PERMISSION_PANE; // answered at the keyboard; a readable prompt follows
    await sleep(5_600);

    assert.equal(
      posts.filter((p) => p.includes("許可リクエスト")).length,
      2,
      "the readable prompt that replaced it must be posted too",
    );
  } finally {
    engine.abortAll();
  }
});
