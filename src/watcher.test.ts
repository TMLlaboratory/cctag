import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { BackgroundWatcher } from "./watcher.js";
import { PairingStore, type Pairing } from "./pairing.js";
import type { Terminals } from "./backend/index.js";
import { BackendUnavailable, type AgentInfo, type AgentStatus, type ScreenSnapshot } from "./backend/types.js";
import type { MessageHandle, Notifier } from "./notifier.js";
import type { TurnEngine } from "./turn.js";
import { encodeCwd } from "./agents/claude/transcript.js";
import { OMP_RESUME_NOTICE } from "./agents/omp/driver.js";
import { formatOmpScreenNotice, ompScreenFingerprint } from "./agents/omp/prompts.js";

const PANE = "wG:p1";
const ORCA_PANE = `orca:${PANE}`;

function fakeAgent(
  status: AgentStatus = "idle",
  cwd = "/tmp/nonexistent-cctag-test",
): AgentInfo {
  return {
    ref: { target: PANE, pid: null, processStartedAt: null },
    backend: "herdr",
    agent: "claude",
    sessionId: "s1",
    evidence: { kind: "classified", status },
    cwd,
    terminalTitle: null,
    terminalId: "herdr-terminal-id",
    displayId: PANE,
  };
}
function fakeOmpAgent(
  path: string,
  sessionId: string,
  cwd: string,
  device = "1",
  inode = "1",
): AgentInfo {
  const transcriptIdentity = { path, device, inode };
  return {
    ...fakeAgent("working", cwd),
    ref: {
      target: ORCA_PANE,
      pid: 42,
      processStartedAt: 1,
      agentKind: "omp",
      sessionId,
      transcriptIdentity,
    },
    backend: "orca",
    agent: "omp",
    sessionId,
    transcriptIdentity,
    evidence: { kind: "hint", state: "working", waitingSince: null },
  };
}

function capturedOmpScreen(filename: string): ScreenSnapshot {
  const capture = JSON.parse(
    readFileSync(new URL(`./agents/omp/__fixtures__/${filename}`, import.meta.url), "utf8"),
  ) as { terminal: Record<string, unknown> };
  const terminal = capture.terminal;
  const tail = terminal.tail;
  const validTail = Array.isArray(tail) && tail.every((row) => typeof row === "string");
  const rows = Array.isArray(tail) ? tail.filter((row): row is string => typeof row === "string") : [];
  return {
    text: rows.join("\n"),
    draft: typeof terminal.draft === "string" ? terminal.draft : null,
    complete:
      validTail &&
      terminal.source === "screen" &&
      terminal.status === "running" &&
      terminal.limited === false &&
      terminal.truncated === false,
  };
}


function fakeTerminals(
  agent: (target: string) => AgentInfo | null | Promise<AgentInfo | null> = () => fakeAgent(),
  paneExists: () => boolean | Promise<boolean> = () => true,
): Terminals {
  return {
    async list() {
      return { agents: [], failures: [], complete: true, notices: [] };
    },
    async get(target: string) {
      return agent(target);
    },
    async exists() {
      return paneExists();
    },
    async read() {
      return { text: "", draft: null, complete: true };
    },
    async submit() {
      return { status: "accepted", draftStashed: false };
    },
    openAnswer() {
      return {
        async digit() {},
        async text() {},
        async move() {},
        async confirm() {},
        complete() {},
      };
    },
    openModelAnswer() {
      return {
        async digit() {},
        async text() {},
        async move() {},
        async confirm() {},
        complete() {},
        async escape() {},
      };
    },
    openBlind() {
      return { async answer() {} };
    },
    openComposer() {
      return { async backTab() {} };
    },
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

function orcaPairing(): Pairing {
  return { ...fakePairing(), key: "C1:2.1", threadTs: "2.1", paneId: ORCA_PANE, backend: "orca" };
}

function fakeNotifier(onPost?: (text: string) => void): { notifier: Notifier; replies: string[] } {
  const replies: string[] = [];
  const handle: MessageHandle = { async update() {} };
  const notifier: Notifier = {
    async postReply(_c, _t, text) {
      replies.push(text);
      onPost?.(text);
    },
    async postMessage(_c, _t, text) {
      replies.push(text);
      onPost?.(text);
      return handle;
    },
  };
  return { notifier, replies };
}

/** A TurnEngine stand-in: nothing is ever busy, so every tick reaches checkPairing. */
const idleEngine = { isBusy: () => false } as unknown as TurnEngine;

function storeWithPairing(dir: string, pairing: Pairing = fakePairing()): PairingStore {
  const store = new PairingStore(join(dir, "pairings.json"));
  store.add(pairing);
  return store;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fakeOrcaHintAgent(cwd: string): AgentInfo {
  return {
    ...fakeAgent("working", cwd),
    ref: { target: ORCA_PANE, pid: 42, processStartedAt: 1 },
    backend: "orca",
    sessionId: "session-a",
    evidence: { kind: "hint", state: "working", waitingSince: null },
  };
}

function fakeOrcaTurnEngine(): TurnEngine {
  return {
    ...idleEngine,
    async uploadOutboxAdditions(...args: Parameters<TurnEngine["uploadOutboxAdditions"]>) {
      return args[2];
    },
  } as unknown as TurnEngine;
}

async function waitForSignal(signal: Promise<void>, description: string): Promise<void> {
  await Promise.race([
    signal,
    sleep(500).then(() => {
      throw new Error(`timed out waiting for ${description}`);
    }),
  ]);
}


test("a pane that has gone away is reported once and unpaired", async () => {
  // Closing the terminal used to be undetectable from Slack: the watcher
  // returned quietly on every tick and the pairing stayed, so the only way to
  // find out was to send a message and have startTurn fail.
  const dir = mkdtempSync(join(tmpdir(), "cctag-watcher-"));
  try {
    const store = storeWithPairing(dir);
    const { notifier, replies } = fakeNotifier();
    const herdr = fakeTerminals(
      () => null,
      () => false,
    );

    const watcher = new BackgroundWatcher("herdr", herdr, store, idleEngine, notifier, 20);
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
  // The distinction that matters: Herdr's `Terminals.get()` returns null only for its own
  // no-such-pane answer, and throws for a timeout or spawn failure. Treating the
  // second as a closed terminal would unpair a live thread whenever herdr
  // hiccuped — e.g. while it restarts after a Homebrew update.
  const dir = mkdtempSync(join(tmpdir(), "cctag-watcher-"));
  try {
    const store = storeWithPairing(dir);
    const { notifier, replies } = fakeNotifier();
    const herdr = fakeTerminals(async () => {
      throw new Error("herdr command timed out");
    });

    const watcher = new BackgroundWatcher("herdr", herdr, store, idleEngine, notifier, 20);
    watcher.start();
    await sleep(150);
    watcher.stop();

    assert.equal(replies.length, 0, "nothing should be posted for a transient failure");
    assert.equal(store.list().length, 1, "the pairing must survive a herdr hiccup");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- a pane that outlives its agent ----------------------------------------

/** A live pane with nothing running in it: `agent get` finds no agent, but the
 *  pane itself is still there — what quitting the CLI looks like, and equally
 *  what exiting it for good looks like. */
function agentlessTerminals(): Terminals {
  return fakeTerminals(() => null, () => true);
}

test("a pane whose agent quit is kept while the CLI could still be restarting", async () => {
  // The grace period exists for exactly this: restarting the CLI in the same
  // pane briefly leaves it agentless, and unpairing then would tear down the
  // pairing that pane-id addressing exists to carry through a restart.
  const dir = mkdtempSync(join(tmpdir(), "cctag-watcher-"));
  try {
    const store = storeWithPairing(dir);
    const { notifier, replies } = fakeNotifier();

    const watcher = new BackgroundWatcher("herdr", agentlessTerminals(), store, idleEngine, notifier, 20, 10_000);
    watcher.start();
    await sleep(150); // several ticks, all well inside the grace period
    watcher.stop();

    assert.equal(replies.length, 0, "nothing should be posted while the restart window is open");
    assert.equal(store.list().length, 1, "the pairing must survive a CLI restart");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a pane still agentless after the grace period is unpaired and reported once", async () => {
  // Without an upper bound this waited forever: exiting the agent and leaving
  // the terminal open — the ordinary way to end a session — left the thread
  // paired to an empty pane, with every later message to it failing.
  const dir = mkdtempSync(join(tmpdir(), "cctag-watcher-"));
  try {
    const store = storeWithPairing(dir);
    const { notifier, replies } = fakeNotifier();

    const watcher = new BackgroundWatcher("herdr", agentlessTerminals(), store, idleEngine, notifier, 20, 40);
    watcher.start();
    await sleep(300); // ticks past the 40ms grace, then keeps ticking
    watcher.stop();

    const notices = replies.filter((r) => r.includes("終了したままです"));
    assert.equal(notices.length, 1, `reported exactly once, got ${notices.length}`);
    assert.equal(store.list().length, 0, "the stale pairing must be dropped");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an agent coming back inside the grace period resets the wait", async () => {
  // The reset is what keeps a pane that flips in and out of agentless — a
  // restart, or a session id that lands a tick late — from accumulating its
  // way to an unpair across unrelated spells.
  const dir = mkdtempSync(join(tmpdir(), "cctag-watcher-"));
  try {
    const store = storeWithPairing(dir);
    const { notifier, replies } = fakeNotifier();
    // One agentless tick, a long stretch with the agent present, then agentless
    // again at the end. The timings are chosen so the two outcomes are far
    // apart rather than adjacent: measured from the FIRST spell the pane has
    // been agentless ~350ms when the watcher stops, well past the 200ms grace;
    // measured from the second it has been ~50ms, well inside it. An earlier
    // version of this test put those two answers ~10ms apart and failed
    // whenever a tick landed on the wrong side of the boundary.
    let calls = 0;
    const herdr = fakeTerminals(
      () => {
        calls += 1;
        return calls === 1 || calls >= 7 ? null : fakeAgent();
      },
      () => true,
    );

    const watcher = new BackgroundWatcher("herdr", herdr, store, idleEngine, notifier, 50, 200);
    watcher.start();
    await sleep(430);
    watcher.stop();

    assert.equal(replies.length, 0, "the wait restarted, so nothing should have expired yet");
    assert.equal(store.list().length, 1);
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
    const herdr = fakeTerminals(() => {
      queried += 1;
      return null;
    });

    const watcher = new BackgroundWatcher("herdr", herdr, store, idleEngine, notifier, 20);
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

/** Synthetic Claude transcript fixture: a user message, assistant reply, and
 *  `turn_duration` record. */
function writeCompletedTurn(dir: string, name: string, text: string): void {
  mkdirSync(dir, { recursive: true });
  const lines = [
    { type: "user", timestamp: "2026-09-27T14:48:48.520Z", message: { role: "user", content: "やって" } },
    {
      type: "assistant",
      timestamp: "2026-09-27T14:48:53.416Z",
      message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text }] },
    },
    { type: "system", subtype: "turn_duration", timestamp: "2026-09-27T14:49:01.083Z", durationMs: 1234 },
  ].map((r) => JSON.stringify(r));
  writeFileSync(join(dir, name), lines.join("\n") + "\n");
}


// Synthetic transcript records for a terminal turn that straddles watcher startup.
function writeStartedTurn(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true });
  const lines = [
    {
      type: "user",
      timestamp: "2026-09-27T14:48:48.520Z",
      message: { role: "user", content: "やって" },
    },
    {
      type: "assistant",
      timestamp: "2026-09-27T14:48:53.416Z",
      message: { role: "assistant", content: [{ type: "text", text: "before EOF baseline" }] },
    },
  ].map((record) => JSON.stringify(record));
  writeFileSync(join(dir, name), `${lines.join("\n")}\n`);
}

function appendCompletedResponse(dir: string, name: string, text: string): void {
  const lines = [
    {
      type: "assistant",
      timestamp: "2026-09-27T14:49:00.000Z",
      message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text }] },
    },
    { type: "system", subtype: "turn_duration", timestamp: "2026-09-27T14:49:01.000Z", durationMs: 1_000 },
  ].map((record) => JSON.stringify(record));
  appendFileSync(join(dir, name), `${lines.join("\n")}\n`);
}

function appendStartedTurn(dir: string, name: string, text: string): void {
  const lines = [
    {
      type: "user",
      timestamp: "2026-09-27T14:50:00.000Z",
      message: { role: "user", content: "次を続けて" },
    },
    {
      type: "assistant",
      timestamp: "2026-09-27T14:50:03.000Z",
      message: { role: "assistant", content: [{ type: "text", text }] },
    },
  ].map((record) => JSON.stringify(record));
  appendFileSync(join(dir, name), `${lines.join("\n")}\n`);
}

function appendTurnCompletion(dir: string, name: string): void {
  const record = {
    type: "system",
    subtype: "turn_duration",
    timestamp: "2026-09-27T14:50:04.000Z",
    durationMs: 1_000,
  };
  appendFileSync(join(dir, name), `${JSON.stringify(record)}\n`);
}
/** The event envelope matches the captured V4 transcript; poll ordering is synthetic. */

function writeCompletedOmpFixture(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, name),
    readFileSync(new URL("./agents/omp/__fixtures__/transcript-lifecycle.jsonl", import.meta.url), "utf8"),
  );
}

function appendOmpStartAndOutput(dir: string, name: string, text: string): void {
  appendRecords(dir, name, [
    {
      type: "message",
      timestamp: "2026-09-28T22:54:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "new request" }] },
    },
    {
      type: "message",
      timestamp: "2026-09-28T22:54:01.000Z",
      message: { role: "assistant", content: [{ type: "text", text }] },
    },
  ]);
}

function appendOmpCompletion(dir: string, name: string): void {
  appendRecords(dir, name, [
    {
      type: "message",
      timestamp: "2026-09-28T22:54:02.000Z",
      message: { role: "assistant", stopReason: "stop", content: [] },
    },
  ]);
}


for (const agentKind of ["omp", "claude"] as const) {
  test(`an Orca ${agentKind} watcher reports a turn started during an incomplete screen read`, {
    timeout: 10_000,
  }, async () => {
    const dir = mkdtempSync(join(tmpdir(), `cctag-orca-watch-incomplete-${agentKind}-`));
    const cwd = mkdtempSync(join(tmpdir(), "cctag-orca-watch-incomplete-cwd-"));
    const storeDir = mkdtempSync(join(tmpdir(), "cctag-orca-watch-store-"));
    const transcriptDir = agentKind === "omp" ? dir : transcriptDirFor(cwd);
    const transcriptName = "session-a.jsonl";
    const transcriptPath = join(transcriptDir, transcriptName);
    const sessionId = "9a51b84e-610c-4d9e-bb20-28d7c850c552";
    const agent = agentKind === "omp"
      ? fakeOmpAgent(transcriptPath, sessionId, cwd)
      : fakeOrcaHintAgent(cwd);
    let watcher: BackgroundWatcher | undefined;
    const incompleteScreenRead = deferred();
    const posted = deferred();
    let uploadCalls = 0;
    let startAppended = false;
    try {
      if (agentKind === "omp") writeCompletedOmpFixture(transcriptDir, transcriptName);
      else writeCompletedTurn(transcriptDir, transcriptName, "old watcher history");

      const { notifier, replies } = fakeNotifier((text) => {
        if (text.includes("new delayed output")) posted.resolve();
      });
      const terminals = fakeTerminals(() => agent);
      terminals.read = async () => {
        if (startAppended) incompleteScreenRead.resolve();
        return { text: "partial screen", draft: null, complete: false };
      };
      const turnEngine = {
        ...idleEngine,
        async uploadOutboxAdditions(...args: Parameters<TurnEngine["uploadOutboxAdditions"]>) {
          uploadCalls++;
          return args[2];
        },
      } as unknown as TurnEngine;
      watcher = new BackgroundWatcher(
        "orca",
        terminals,
        storeWithPairing(storeDir, { ...orcaPairing(), cwd }),
        turnEngine,
        notifier,
        20,
      );
      watcher.start();
      await sleep(80); // Establish the EOF baseline beyond the completed history.
      assert.equal(replies.length, 0, "historical output must not be reported");

      if (agentKind === "omp") appendOmpStartAndOutput(dir, transcriptName, "new delayed output");
      else appendStartedTurn(transcriptDir, transcriptName, "new delayed output");
      startAppended = true;
      await waitForSignal(incompleteScreenRead.promise, "the incomplete start-poll screen");
      assert.equal(replies.length, 0, "the incomplete start poll must not report");

      if (agentKind === "omp") appendOmpCompletion(dir, transcriptName);
      else appendTurnCompletion(transcriptDir, transcriptName);
      await waitForSignal(posted.promise, "the post-baseline completion report");
      await sleep(80); // Let a later idle poll prove the start flag was consumed.

      assert.equal(replies.filter((reply) => reply.includes("new delayed output")).length, 1);
      assert.equal(replies.some((reply) => reply.includes("old watcher history")), false);
      assert.equal(uploadCalls, 1, "the settled turn must be reported only once");
    } finally {
      watcher?.stop();
      rmSync(transcriptDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
      rmSync(storeDir, { recursive: true, force: true });
    }
  });

  test(`an Orca ${agentKind} watcher ignores historical completion without a new start`, async () => {
    const dir = mkdtempSync(join(tmpdir(), `cctag-orca-watch-history-${agentKind}-`));
    const cwd = mkdtempSync(join(tmpdir(), "cctag-orca-watch-history-cwd-"));
    const storeDir = mkdtempSync(join(tmpdir(), "cctag-orca-watch-store-"));
    const transcriptDir = agentKind === "omp" ? dir : transcriptDirFor(cwd);
    const transcriptName = "session-a.jsonl";
    const transcriptPath = join(transcriptDir, transcriptName);
    const agent = agentKind === "omp"
      ? fakeOmpAgent(transcriptPath, "9a51b84e-610c-4d9e-bb20-28d7c850c552", cwd)
      : fakeOrcaHintAgent(cwd);
    let watcher: BackgroundWatcher | undefined;
    try {
      if (agentKind === "omp") writeCompletedOmpFixture(transcriptDir, transcriptName);
      else writeCompletedTurn(transcriptDir, transcriptName, "old watcher history");

      const { notifier, replies } = fakeNotifier();
      const terminals = fakeTerminals(() => agent);
      const turnEngine = fakeOrcaTurnEngine();
      watcher = new BackgroundWatcher(
        "orca",
        terminals,
        storeWithPairing(storeDir, { ...orcaPairing(), cwd }),
        turnEngine,
        notifier,
        20,
      );
      watcher.start();
      await sleep(100);
      watcher.stop();

      assert.deepEqual(replies, [], "a baseline completion without a post-baseline start is inactive");
    } finally {
      watcher?.stop();
      rmSync(transcriptDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
      rmSync(storeDir, { recursive: true, force: true });
    }
  });
}




/** A pane reporting no session id, whose status the test can flip. */
function rotatingTerminals(cwd: string, status: () => AgentStatus): Terminals {
  return fakeTerminals(() => ({ ...fakeAgent(status(), cwd), sessionId: null }));
}

/** An engine stand-in whose pane can be reported busy for one tick, standing in
 *  for a Slack turn holding it — which is what makes the watcher resume with
 *  forceRebaseline set. */
function engineBusyOnce(): { engine: TurnEngine; setBusy: (ticks: number) => void } {
  let remaining = 0;
  const engine = {
    isBusy: () => {
      if (remaining > 0) {
        remaining -= 1;
        return true;
      }
      return false;
    },
  } as unknown as TurnEngine;
  return { engine, setBusy: (ticks: number) => (remaining = ticks) };
}

async function withRotationFixture(
  run: (ctx: {
    cwd: string;
    tDir: string;
    store: PairingStore;
    replies: string[];
    setStatus: (s: AgentStatus) => void;
    /** Report the pane busy for the next N ticks, as a Slack turn would. */
    setBusy: (ticks: number) => void;
    /** Make the transcript directory unresolvable, as a transient failure would. */
    hideTranscript: (hidden: boolean) => void;
    start: () => BackgroundWatcher;
  }) => Promise<void>,
): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), "cctag-rot-"));
  const tDir = transcriptDirFor(cwd);
  const hiddenDir = tDir + "-hidden";
  const storeDir = mkdtempSync(join(tmpdir(), "cctag-rot-store-"));
  let status: AgentStatus = "working";
  let watcher: BackgroundWatcher | undefined;
  const { engine, setBusy } = engineBusyOnce();
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
      setBusy,
      hideTranscript: (hidden) => {
        // Renaming the directory is how a locator gets its readdir failure.
        if (hidden) renameSync(tDir, hiddenDir);
        else renameSync(hiddenDir, tDir);
      },
      start: () => {
        watcher = new BackgroundWatcher(
          "herdr",
          rotatingTerminals(cwd, () => status),
          store,
          engine,
          notifier,
          20,
        );
        watcher.start();
        return watcher;
      },
    });
  } finally {
    watcher?.stop();
    rmSync(hiddenDir, { recursive: true, force: true });
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

test("a pane herdr reports as working forever still gets its terminal-side response posted", async () => {
  // The production failure: a lingering background shell makes herdr report
  // `working` permanently (background_shell_working outranks every idle rule),
  // so `nowSettled` never became true and text this loop had already collected
  // was never posted. The transcript's own turn boundary is what settles it —
  // note that setStatus is never called here, unlike every test above.
  await withRotationFixture(async ({ tDir, replies, start }) => {
    start();
    await sleep(80);

    writeCompletedTurn(tDir, "session-a.jsonl", "ターミナル側で書いた結果");
    await sleep(220); // notice the transcript, then tail and settle it

    const hits = replies.filter((r) => r.includes("ターミナル側で書いた結果"));
    assert.equal(hits.length, 1, `posted exactly once while stuck at working, got ${JSON.stringify(replies)}`);

    // And not again on later ticks: the corrected status is what gets stored,
    // so `wasActive` goes false instead of latching on herdr's stale `working`.
    await sleep(160);
    assert.equal(replies.filter((r) => r.includes("ターミナル側で書いた結果")).length, 1, "must not re-report");
  });
});

test("an Orca watcher reports a turn that began before its EOF baseline when it later completes", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cctag-orca-watch-baseline-"));
  const transcriptDir = transcriptDirFor(cwd);
  const storeDir = mkdtempSync(join(tmpdir(), "cctag-orca-watch-store-"));
  const transcriptName = "session-a.jsonl";
  let watcher: BackgroundWatcher | undefined;
  try {
    writeStartedTurn(transcriptDir, transcriptName);
    const pairing = { ...orcaPairing(), cwd };
    const store = storeWithPairing(storeDir, pairing);
    const { notifier, replies } = fakeNotifier();
    const agent: AgentInfo = {
      ...fakeAgent("working", cwd),
      ref: { target: ORCA_PANE, pid: 42, processStartedAt: 1 },
      backend: "orca",
      sessionId: "session-a",
      evidence: { kind: "hint", state: "working", waitingSince: null },
    };
    const turnEngine = {
      ...idleEngine,
      async uploadOutboxAdditions(...args: Parameters<TurnEngine["uploadOutboxAdditions"]>) {
        return args[2];
      },
    } as unknown as TurnEngine;
    watcher = new BackgroundWatcher("orca", fakeTerminals(() => agent), store, turnEngine, notifier, 20);
    watcher.start();
    await sleep(80); // The watcher has baselined at EOF and observed the existing start.

    assert.equal(replies.some((reply) => reply.includes("before EOF baseline")), false);
    appendCompletedResponse(transcriptDir, transcriptName, "watcher response after baseline");
    for (let i = 0; i < 30 && !replies.some((reply) => reply.includes("watcher response after baseline")); i++) {
      await sleep(20);
    }

    assert.equal(
      replies.filter((reply) => reply.includes("watcher response after baseline")).length,
      1,
      `the post-baseline completion should report only new output, got ${JSON.stringify(replies)}`,
    );
  } finally {
    watcher?.stop();
    rmSync(transcriptDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(storeDir, { recursive: true, force: true });
  }
});

test("an Orca watcher does not settle from a completion before its EOF baseline", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cctag-orca-watch-stale-end-"));
  const transcriptDir = transcriptDirFor(cwd);
  const storeDir = mkdtempSync(join(tmpdir(), "cctag-orca-watch-store-"));
  const transcriptName = "session-a.jsonl";
  let watcher: BackgroundWatcher | undefined;
  try {
    writeCompletedTurn(transcriptDir, transcriptName, "old watcher history");
    const pairing = { ...orcaPairing(), cwd };
    const store = storeWithPairing(storeDir, pairing);
    const { notifier, replies } = fakeNotifier();
    const agent: AgentInfo = {
      ...fakeAgent("working", cwd),
      ref: { target: ORCA_PANE, pid: 42, processStartedAt: 1 },
      backend: "orca",
      sessionId: "session-a",
      evidence: { kind: "hint", state: "working", waitingSince: null },
    };
    const turnEngine = {
      ...idleEngine,
      async uploadOutboxAdditions(...args: Parameters<TurnEngine["uploadOutboxAdditions"]>) {
        return args[2];
      },
    } as unknown as TurnEngine;
    watcher = new BackgroundWatcher("orca", fakeTerminals(() => agent), store, turnEngine, notifier, 20);
    watcher.start();
    await sleep(80); // The old completion and its output are before the EOF baseline.

    assert.equal(replies.some((reply) => reply.includes("old watcher history")), false);
    appendStartedTurn(transcriptDir, transcriptName, "new watcher turn");
    await sleep(80); // Let the watcher observe the new start while it is still running.
    assert.equal(replies.some((reply) => reply.includes("new watcher turn")), false);
    appendTurnCompletion(transcriptDir, transcriptName);
    for (let i = 0; i < 30 && !replies.some((reply) => reply.includes("new watcher turn")); i++) {
      await sleep(20);
    }

    assert.equal(
      replies.filter((reply) => reply.includes("new watcher turn")).length,
      1,
      `only the post-baseline turn should be reported, got ${JSON.stringify(replies)}`,
    );
  } finally {
    watcher?.stop();
    rmSync(transcriptDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(storeDir, { recursive: true, force: true });
  }
});

// These watcher-loop integration tests have no manual tick trigger; short real
// poll intervals launch each tick, while deferred terminal reads control races.
test("an Orca watcher finds a baseline start beyond both bounded suffix limits", { timeout: 10_000 }, async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "cctag-orca-watch-long-start-"));
  const transcriptDir = transcriptDirFor(cwd);
  const storeDir = mkdtempSync(join(tmpdir(), "cctag-orca-watch-store-"));
  const transcriptName = "session-a.jsonl";
  const transcriptPath = join(transcriptDir, transcriptName);
  let watcher: BackgroundWatcher | undefined;
  t.after(() => {
    watcher?.stop();
    rmSync(transcriptDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(storeDir, { recursive: true, force: true });
  });
  try {
    writeStartedTurn(transcriptDir, transcriptName);
    const history = Array.from({ length: 300 }, (_, i) =>
      JSON.stringify({
        type: "user",
        timestamp: "2026-09-27T14:48:54.000Z",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: `tool-${i}`, content: "x".repeat(1_024) }],
        },
      }),
    ).join("\n");
    assert.ok(Buffer.byteLength(history) > 256 * 1024);
    appendFileSync(transcriptPath, `${history}\n`);

    const agent: AgentInfo = {
      ...fakeAgent("working", cwd),
      ref: { target: ORCA_PANE, pid: 42, processStartedAt: 1 },
      backend: "orca",
      sessionId: "session-a",
      evidence: { kind: "hint", state: "working", waitingSince: null },
    };
    const pairing = { ...orcaPairing(), cwd };
    const store = storeWithPairing(storeDir, pairing);
    const posted = deferred();
    const { notifier, replies } = fakeNotifier((text) => {
      if (text.includes("long-turn response")) posted.resolve();
    });
    const thirdTick = deferred();
    let getCount = 0;
    const terminals = fakeTerminals(() => {
      getCount += 1;
      if (getCount === 3) thirdTick.resolve();
      return agent;
    });
    const turnEngine = {
      ...idleEngine,
      async uploadOutboxAdditions(...args: Parameters<TurnEngine["uploadOutboxAdditions"]>) {
        return args[2];
      },
    } as unknown as TurnEngine;
    watcher = new BackgroundWatcher("orca", terminals, store, turnEngine, notifier, 10);
    watcher.start();

    await thirdTick.promise;
    appendCompletedResponse(transcriptDir, transcriptName, "long-turn response");
    await posted.promise;

    assert.equal(replies.filter((reply) => reply.includes("long-turn response")).length, 1);
    assert.equal(replies.some((reply) => reply.includes("before EOF baseline")), false);
  } finally {
    watcher?.stop();
    rmSync(transcriptDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(storeDir, { recursive: true, force: true });
  }
});

test("an Orca watcher reads the baseline at its captured offset", { timeout: 10_000 }, async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "cctag-orca-watch-baseline-race-"));
  const transcriptDir = transcriptDirFor(cwd);
  const storeDir = mkdtempSync(join(tmpdir(), "cctag-orca-watch-store-"));
  const transcriptName = "session-a.jsonl";
  const transcriptPath = join(transcriptDir, transcriptName);
  const baselineReadEntered = deferred();
  const releaseBaselineRead = deferred();
  let capturedOffset = -1;
  let watcher: BackgroundWatcher | undefined;
  t.after(() => {
    releaseBaselineRead.resolve();
    watcher?.stop();
    rmSync(transcriptDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(storeDir, { recursive: true, force: true });
  });
  try {
    writeStartedTurn(transcriptDir, transcriptName);
    const expectedOffset = statSync(transcriptPath).size;
    const agent: AgentInfo = {
      ...fakeAgent("working", cwd),
      ref: { target: ORCA_PANE, pid: 42, processStartedAt: 1 },
      backend: "orca",
      sessionId: "session-a",
      evidence: { kind: "hint", state: "working", waitingSince: null },
    };
    const pairing = { ...orcaPairing(), cwd };
    const store = storeWithPairing(storeDir, pairing);
    const posted = deferred();
    const { notifier, replies } = fakeNotifier((text) => {
      if (text.includes("raced baseline response")) posted.resolve();
    });
    const turnEngine = {
      ...idleEngine,
      async uploadOutboxAdditions(...args: Parameters<TurnEngine["uploadOutboxAdditions"]>) {
        return args[2];
      },
    } as unknown as TurnEngine;
    watcher = new BackgroundWatcher(
      "orca",
      fakeTerminals(() => agent),
      store,
      turnEngine,
      notifier,
      10,
      undefined,
      async (_path, offset) => {
        capturedOffset = offset;
        baselineReadEntered.resolve();
        await releaseBaselineRead.promise;
      },
    );
    watcher.start();

    await baselineReadEntered.promise;
    assert.equal(capturedOffset, expectedOffset);
    appendCompletedResponse(transcriptDir, transcriptName, "raced baseline response");
    releaseBaselineRead.resolve();
    await posted.promise;

    assert.equal(replies.filter((reply) => reply.includes("raced baseline response")).length, 1);
    assert.equal(replies.some((reply) => reply.includes("before EOF baseline")), false);
  } finally {
    releaseBaselineRead.resolve();
    watcher?.stop();
    rmSync(transcriptDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(storeDir, { recursive: true, force: true });
  }
});

test("an Orca watcher reads a start record split at its baseline", { timeout: 10_000 }, async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "cctag-orca-watch-split-start-"));
  const transcriptDir = transcriptDirFor(cwd);
  const storeDir = mkdtempSync(join(tmpdir(), "cctag-orca-watch-store-"));
  const transcriptName = "session-a.jsonl";
  const transcriptPath = join(transcriptDir, transcriptName);
  const baselineReadEntered = deferred();
  const releaseBaselineRead = deferred();
  const posted = deferred();
  let capturedOffset = -1;
  let watcher: BackgroundWatcher | undefined;
  t.after(() => {
    releaseBaselineRead.resolve();
    watcher?.stop();
    rmSync(transcriptDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(storeDir, { recursive: true, force: true });
  });

  mkdirSync(transcriptDir, { recursive: true });
  const priorRecord = JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "old baseline output" }] },
  });
  const startRecord = JSON.stringify({
    type: "user",
    timestamp: "2026-09-27T14:50:00.000Z",
    message: { role: "user", content: "次を続けて" },
  });
  const splitAt = Math.floor(startRecord.length / 2);
  writeFileSync(transcriptPath, `${priorRecord}\n${startRecord.slice(0, splitAt)}`);
  const expectedOffset = statSync(transcriptPath).size;
  const agent = fakeOrcaHintAgent(cwd);
  const store = storeWithPairing(storeDir, { ...orcaPairing(), cwd });
  const { notifier, replies } = fakeNotifier((text) => {
    if (text.includes("split-start response")) posted.resolve();
  });
  watcher = new BackgroundWatcher(
    "orca",
    fakeTerminals(() => agent),
    store,
    fakeOrcaTurnEngine(),
    notifier,
    10,
    undefined,
    async (_path, offset) => {
      capturedOffset = offset;
      baselineReadEntered.resolve();
      await releaseBaselineRead.promise;
    },
  );
  watcher.start();

  await waitForSignal(baselineReadEntered.promise, "the split-start baseline barrier");
  assert.equal(capturedOffset, expectedOffset);
  appendFileSync(transcriptPath, `${startRecord.slice(splitAt)}\n`);
  appendCompletedResponse(transcriptDir, transcriptName, "split-start response");
  releaseBaselineRead.resolve();
  await waitForSignal(posted.promise, "the split-start response");

  assert.equal(replies.filter((reply) => reply.includes("split-start response")).length, 1);
  assert.equal(replies.some((reply) => reply.includes("old baseline output")), false);
});

test("an Orca watcher reads a completion record split at its baseline", { timeout: 10_000 }, async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "cctag-orca-watch-split-end-"));
  const transcriptDir = transcriptDirFor(cwd);
  const storeDir = mkdtempSync(join(tmpdir(), "cctag-orca-watch-store-"));
  const transcriptName = "session-a.jsonl";
  const transcriptPath = join(transcriptDir, transcriptName);
  const baselineReadEntered = deferred();
  const releaseBaselineRead = deferred();
  const posted = deferred();
  let capturedOffset = -1;
  let watcher: BackgroundWatcher | undefined;
  t.after(() => {
    releaseBaselineRead.resolve();
    watcher?.stop();
    rmSync(transcriptDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(storeDir, { recursive: true, force: true });
  });

  writeStartedTurn(transcriptDir, transcriptName);
  const completionRecord = JSON.stringify({
    type: "assistant",
    timestamp: "2026-09-27T14:50:04.000Z",
    message: {
      role: "assistant",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "split-completion response" }],
    },
  });
  const splitAt = Math.floor(completionRecord.length / 2);
  appendFileSync(transcriptPath, completionRecord.slice(0, splitAt));
  const expectedOffset = statSync(transcriptPath).size;
  const agent = fakeOrcaHintAgent(cwd);
  const store = storeWithPairing(storeDir, { ...orcaPairing(), cwd });
  const { notifier, replies } = fakeNotifier((text) => {
    if (text.includes("split-completion response")) posted.resolve();
  });
  watcher = new BackgroundWatcher(
    "orca",
    fakeTerminals(() => agent),
    store,
    fakeOrcaTurnEngine(),
    notifier,
    10,
    undefined,
    async (_path, offset) => {
      capturedOffset = offset;
      baselineReadEntered.resolve();
      await releaseBaselineRead.promise;
    },
  );
  watcher.start();

  await waitForSignal(baselineReadEntered.promise, "the split-completion baseline barrier");
  assert.equal(capturedOffset, expectedOffset);
  appendFileSync(transcriptPath, `${completionRecord.slice(splitAt)}\n`);
  releaseBaselineRead.resolve();
  await waitForSignal(posted.promise, "the split-completion response");

  assert.equal(replies.filter((reply) => reply.includes("split-completion response")).length, 1);
  assert.equal(replies.some((reply) => reply.includes("before EOF baseline")), false);
});

for (const mutation of ["truncation", "short replacement"] as const) {
  test(`an Orca watcher rebaselines after ${mutation} during lifecycle scanning`, { timeout: 10_000 }, async (t) => {
    const cwd = mkdtempSync(join(tmpdir(), `cctag-orca-watch-baseline-${mutation.replace(" ", "-")}-`));
    const transcriptDir = transcriptDirFor(cwd);
    const storeDir = mkdtempSync(join(tmpdir(), "cctag-orca-watch-store-"));
    const transcriptName = "session-a.jsonl";
    const transcriptPath = join(transcriptDir, transcriptName);
    const baselineReadEntered = deferred();
    const releaseBaselineRead = deferred();
    const rebaselineRead = deferred();
    const startProcessed = deferred();
    const posted = deferred();
    let capturedOffset = -1;
    let rebaselineOffset = -1;
    let baselineReads = 0;
    let getCount = 0;
    let watcher: BackgroundWatcher | undefined;
    t.after(() => {
      releaseBaselineRead.resolve();
      watcher?.stop();
      rmSync(transcriptDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
      rmSync(storeDir, { recursive: true, force: true });
    });

    writeStartedTurn(transcriptDir, transcriptName);
    appendFileSync(
      transcriptPath,
      `${JSON.stringify({
        type: "user",
        timestamp: "2026-09-27T14:49:00.000Z",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "large", content: "x".repeat(4_096) }] },
      })}\n`,
    );
    const agent = fakeOrcaHintAgent(cwd);
    const store = storeWithPairing(storeDir, { ...orcaPairing(), cwd });
    const { notifier, replies } = fakeNotifier((text) => {
      if (text.includes("new post-rebaseline completion")) posted.resolve();
    });
    watcher = new BackgroundWatcher(
      "orca",
      fakeTerminals(() => {
        getCount += 1;
        if (getCount === 4) startProcessed.resolve();
        return agent;
      }),
      store,
      fakeOrcaTurnEngine(),
      notifier,
      10,
      undefined,
      async (_path, offset) => {
        baselineReads += 1;
        if (baselineReads === 1) {
          capturedOffset = offset;
          baselineReadEntered.resolve();
          await releaseBaselineRead.promise;
        } else if (baselineReads === 2) {
          rebaselineOffset = offset;
          rebaselineRead.resolve();
        }
      },
    );
    watcher.start();

    await waitForSignal(baselineReadEntered.promise, "the original baseline barrier");
    if (mutation === "truncation") {
      writeFileSync(transcriptPath, "{}\n");
    } else {
      const replacementPath = join(transcriptDir, "replacement.jsonl");
      writeCompletedTurn(transcriptDir, "replacement.jsonl", "replacement history");
      assert.ok(statSync(replacementPath).size < capturedOffset);
      renameSync(replacementPath, transcriptPath);
    }
    const replacementOffset = statSync(transcriptPath).size;
    assert.ok(replacementOffset < capturedOffset);
    releaseBaselineRead.resolve();
    await waitForSignal(rebaselineRead.promise, "a fresh baseline after the shorter transcript");
    assert.equal(rebaselineOffset, replacementOffset);

    appendStartedTurn(transcriptDir, transcriptName, "new post-rebaseline turn");
    await waitForSignal(startProcessed.promise, "the post-rebaseline start record");
    assert.equal(replies.some((reply) => reply.includes("new post-rebaseline completion")), false);
    appendCompletedResponse(transcriptDir, transcriptName, "new post-rebaseline completion");
    await waitForSignal(posted.promise, "the post-rebaseline completion");

    assert.equal(replies.filter((reply) => reply.includes("new post-rebaseline completion")).length, 1);
    assert.equal(replies.some((reply) => reply.includes("replacement history")), false);
    assert.equal(replies.some((reply) => reply.includes("before EOF baseline")), false);
  });
}

test("an Orca watcher rebaselines when a later tick finds a shorter transcript", { timeout: 10_000 }, async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "cctag-orca-watch-later-shrink-"));
  const transcriptDir = transcriptDirFor(cwd);
  const storeDir = mkdtempSync(join(tmpdir(), "cctag-orca-watch-store-"));
  const transcriptName = "session-a.jsonl";
  const transcriptPath = join(transcriptDir, transcriptName);
  const secondGet = deferred();
  const releaseSecondGet = deferred();
  const rebaselineRead = deferred();
  const startProcessed = deferred();
  const posted = deferred();
  let baselineReads = 0;
  let getCount = 0;
  let watcher: BackgroundWatcher | undefined;
  t.after(() => {
    releaseSecondGet.resolve();
    watcher?.stop();
    rmSync(transcriptDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(storeDir, { recursive: true, force: true });
  });

  writeStartedTurn(transcriptDir, transcriptName);
  appendFileSync(
    transcriptPath,
    `${JSON.stringify({
      type: "user",
      timestamp: "2026-09-27T14:49:00.000Z",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "large", content: "x".repeat(4_096) }] },
    })}\n`,
  );
  const originalOffset = statSync(transcriptPath).size;
  const agent = fakeOrcaHintAgent(cwd);
  const store = storeWithPairing(storeDir, { ...orcaPairing(), cwd });
  const { notifier, replies } = fakeNotifier((text) => {
    if (text.includes("later post-rebaseline completion")) posted.resolve();
  });
  watcher = new BackgroundWatcher(
    "orca",
    fakeTerminals(async () => {
      getCount += 1;
      if (getCount === 2) {
        secondGet.resolve();
        await releaseSecondGet.promise;
      }
      if (getCount === 5) startProcessed.resolve();
      return agent;
    }),
    store,
    fakeOrcaTurnEngine(),
    notifier,
    10,
    undefined,
    async () => {
      baselineReads += 1;
      if (baselineReads === 2) rebaselineRead.resolve();
    },
  );
  watcher.start();

  await waitForSignal(secondGet.promise, "the first post-baseline tick");
  writeFileSync(transcriptPath, "{}\n");
  assert.ok(statSync(transcriptPath).size < originalOffset);
  releaseSecondGet.resolve();
  await waitForSignal(rebaselineRead.promise, "a fresh baseline after the later shrink");

  appendStartedTurn(transcriptDir, transcriptName, "later post-rebaseline turn");
  await waitForSignal(startProcessed.promise, "the later post-rebaseline start record");
  assert.equal(replies.some((reply) => reply.includes("later post-rebaseline completion")), false);
  appendCompletedResponse(transcriptDir, transcriptName, "later post-rebaseline completion");
  await waitForSignal(posted.promise, "the later post-rebaseline completion");

  assert.equal(replies.filter((reply) => reply.includes("later post-rebaseline completion")).length, 1);
  assert.equal(replies.some((reply) => reply.includes("before EOF baseline")), false);
});

test("an Orca watcher preserves collected output across a transient transcript absence", { timeout: 10_000 }, async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "cctag-orca-watch-transient-missing-"));
  const transcriptDir = transcriptDirFor(cwd);
  const hiddenDir = transcriptDir + "-hidden";
  const storeDir = mkdtempSync(join(tmpdir(), "cctag-orca-watch-store-"));
  const transcriptName = "session-a.jsonl";
  const secondGet = deferred();
  const releaseSecondGet = deferred();
  const thirdGet = deferred();
  const releaseThirdGet = deferred();
  const fourthGet = deferred();
  const releaseFourthGet = deferred();
  const fifthGet = deferred();
  let getCount = 0;
  let watcher: BackgroundWatcher | undefined;
  t.after(() => {
    releaseSecondGet.resolve();
    releaseThirdGet.resolve();
    releaseFourthGet.resolve();
    watcher?.stop();
    rmSync(transcriptDir, { recursive: true, force: true });
    rmSync(hiddenDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(storeDir, { recursive: true, force: true });
  });

  writeStartedTurn(transcriptDir, transcriptName);
  const agent = fakeOrcaHintAgent(cwd);
  const store = storeWithPairing(storeDir, { ...orcaPairing(), cwd });
  const posted = deferred();
  const { notifier, replies } = fakeNotifier((text) => {
    if (text.includes("orca transient output")) posted.resolve();
  });
  const terminals = fakeTerminals(async () => {
    getCount += 1;
    if (getCount === 2) {
      secondGet.resolve();
      await releaseSecondGet.promise;
    }
    if (getCount === 3) {
      thirdGet.resolve();
      await releaseThirdGet.promise;
    }
    if (getCount === 4) {
      fourthGet.resolve();
      await releaseFourthGet.promise;
    }
    if (getCount === 5) fifthGet.resolve();
    return agent;
  });
  watcher = new BackgroundWatcher("orca", terminals, store, fakeOrcaTurnEngine(), notifier, 10);
  watcher.start();

  await waitForSignal(secondGet.promise, "the first post-baseline tick");
  appendStartedTurn(transcriptDir, transcriptName, "orca transient output");
  releaseSecondGet.resolve();
  await waitForSignal(thirdGet.promise, "the collected-output tick");
  assert.equal(replies.some((reply) => reply.includes("orca transient output")), false);

  renameSync(transcriptDir, hiddenDir);
  releaseThirdGet.resolve();
  await waitForSignal(fourthGet.promise, "the tick after transient absence");
  renameSync(hiddenDir, transcriptDir);
  appendCompletedResponse(transcriptDir, transcriptName, "orca completion after transient absence");
  releaseFourthGet.resolve();
  await waitForSignal(posted.promise, "the post-absence Orca response");
  await waitForSignal(fifthGet.promise, "the following Orca tick");

  assert.equal(
    replies.filter((reply) => reply.includes("orca transient output")).length,
    1,
    `the retained output should be posted exactly once, got ${JSON.stringify(replies)}`,
  );
  assert.equal(replies.some((reply) => reply.includes("before EOF baseline")), false);
});


test("an Orca watcher reports a whole turn completed between polls", { timeout: 10_000 }, async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "cctag-orca-watch-one-tick-"));
  const transcriptDir = transcriptDirFor(cwd);
  const storeDir = mkdtempSync(join(tmpdir(), "cctag-orca-watch-store-"));
  const transcriptName = "session-a.jsonl";
  let watcher: BackgroundWatcher | undefined;
  const releaseSecondGet = deferred();
  t.after(() => {
    releaseSecondGet.resolve();
    watcher?.stop();
    rmSync(transcriptDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(storeDir, { recursive: true, force: true });
  });
  try {
    writeCompletedTurn(transcriptDir, transcriptName, "old watcher history");
    const agent: AgentInfo = {
      ...fakeAgent("idle", cwd),
      ref: { target: ORCA_PANE, pid: 42, processStartedAt: 1 },
      backend: "orca",
      sessionId: "session-a",
      evidence: { kind: "hint", state: "done", waitingSince: null },
    };
    const pairing = { ...orcaPairing(), cwd };
    const store = storeWithPairing(storeDir, pairing);
    const posted = deferred();
    const { notifier, replies } = fakeNotifier((text) => {
      if (text.includes("one-tick output")) posted.resolve();
    });
    const secondGet = deferred();
    const thirdGet = deferred();
    let getCount = 0;
    const terminals = fakeTerminals(async () => {
      getCount += 1;
      if (getCount === 2) {
        secondGet.resolve();
        await releaseSecondGet.promise;
      }
      if (getCount === 3) thirdGet.resolve();
      return agent;
    });
    const turnEngine = {
      ...idleEngine,
      async uploadOutboxAdditions(...args: Parameters<TurnEngine["uploadOutboxAdditions"]>) {
        return args[2];
      },
    } as unknown as TurnEngine;
    watcher = new BackgroundWatcher("orca", terminals, store, turnEngine, notifier, 10);
    watcher.start();

    await secondGet.promise;
    appendStartedTurn(transcriptDir, transcriptName, "one-tick output");
    appendCompletedResponse(transcriptDir, transcriptName, "one-tick final output");
    releaseSecondGet.resolve();
    await posted.promise;
    await thirdGet.promise;

    assert.equal(replies.filter((reply) => reply.includes("one-tick output")).length, 1);
    assert.equal(replies.some((reply) => reply.includes("old watcher history")), false);
  } finally {
    releaseSecondGet.resolve();
    watcher?.stop();
    rmSync(transcriptDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(storeDir, { recursive: true, force: true });
  }
});

test("a herdr watcher reports a whole turn completed between polls", {
  timeout: 10_000,
  todo: "herdr one-tick gap, separate issue",
}, async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "cctag-herdr-watch-one-tick-"));
  const transcriptDir = transcriptDirFor(cwd);
  const storeDir = mkdtempSync(join(tmpdir(), "cctag-herdr-watch-store-"));
  const transcriptName = "session-a.jsonl";
  const releaseSecondGet = deferred();
  let watcher: BackgroundWatcher | undefined;
  t.after(() => {
    releaseSecondGet.resolve();
    watcher?.stop();
    rmSync(transcriptDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(storeDir, { recursive: true, force: true });
  });
  try {
    writeCompletedTurn(transcriptDir, transcriptName, "old herdr history");
    const agent = { ...fakeAgent("idle", cwd), sessionId: "session-a" };
    const pairing = { ...fakePairing(), cwd };
    const store = storeWithPairing(storeDir, pairing);
    const posted = deferred();
    const { notifier, replies } = fakeNotifier((text) => {
      if (text.includes("herdr one-tick output")) posted.resolve();
    });
    const secondGet = deferred();
    const thirdGet = deferred();
    let getCount = 0;
    const terminals = fakeTerminals(async () => {
      getCount += 1;
      if (getCount === 2) {
        secondGet.resolve();
        await releaseSecondGet.promise;
      }
      if (getCount === 3) thirdGet.resolve();
      return agent;
    });
    const turnEngine = {
      ...idleEngine,
      async uploadOutboxAdditions(...args: Parameters<TurnEngine["uploadOutboxAdditions"]>) {
        return args[2];
      },
    } as unknown as TurnEngine;
    watcher = new BackgroundWatcher("herdr", terminals, store, turnEngine, notifier, 10);
    watcher.start();

    await secondGet.promise;
    appendStartedTurn(transcriptDir, transcriptName, "herdr one-tick output");
    appendCompletedResponse(transcriptDir, transcriptName, "herdr one-tick final output");
    releaseSecondGet.resolve();
    await thirdGet.promise;

    assert.equal(
      replies.filter((reply) => reply.includes("herdr one-tick output")).length,
      1,
      `the one-poll turn should report once, got ${JSON.stringify(replies)}`,
    );
    assert.equal(replies.some((reply) => reply.includes("old herdr history")), false);
  } finally {
    releaseSecondGet.resolve();
    watcher?.stop();
    rmSync(transcriptDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(storeDir, { recursive: true, force: true });
  }
});

test("a Herdr watcher preserves collected output across a transient transcript absence", { timeout: 10_000 }, async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "cctag-herdr-watch-transient-missing-"));
  const transcriptDir = transcriptDirFor(cwd);
  const hiddenDir = transcriptDir + "-hidden";
  const storeDir = mkdtempSync(join(tmpdir(), "cctag-herdr-watch-store-"));
  const transcriptName = "session-a.jsonl";
  const secondGet = deferred();
  const releaseSecondGet = deferred();
  const thirdGet = deferred();
  const releaseThirdGet = deferred();
  const fourthGet = deferred();
  const releaseFourthGet = deferred();
  const fifthGet = deferred();
  let status: AgentStatus = "working";
  let getCount = 0;
  let watcher: BackgroundWatcher | undefined;
  t.after(() => {
    releaseSecondGet.resolve();
    releaseThirdGet.resolve();
    releaseFourthGet.resolve();
    watcher?.stop();
    rmSync(transcriptDir, { recursive: true, force: true });
    rmSync(hiddenDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(storeDir, { recursive: true, force: true });
  });

  writeCompletedTurn(transcriptDir, transcriptName, "old herdr history");
  const store = storeWithPairing(storeDir, { ...fakePairing(), cwd });
  const turnEngine = {
    ...idleEngine,
    async uploadOutboxAdditions(...args: Parameters<TurnEngine["uploadOutboxAdditions"]>) {
      return args[2];
    },
  } as unknown as TurnEngine;
  const posted = deferred();
  const { notifier, replies } = fakeNotifier((text) => {
    if (text.includes("herdr transient output")) posted.resolve();
  });
  const terminals = fakeTerminals(async () => {
    getCount += 1;
    if (getCount === 2) {
      secondGet.resolve();
      await releaseSecondGet.promise;
    }
    if (getCount === 3) {
      thirdGet.resolve();
      await releaseThirdGet.promise;
    }
    if (getCount === 4) {
      fourthGet.resolve();
      await releaseFourthGet.promise;
    }
    if (getCount === 5) fifthGet.resolve();
    return { ...fakeAgent(status, cwd), sessionId: "session-a" };
  });
  watcher = new BackgroundWatcher("herdr", terminals, store, turnEngine, notifier, 10);
  watcher.start();

  await waitForSignal(secondGet.promise, "the first post-baseline tick");
  appendStartedTurn(transcriptDir, transcriptName, "herdr transient output");
  releaseSecondGet.resolve();
  await waitForSignal(thirdGet.promise, "the collected-output tick");
  assert.equal(replies.some((reply) => reply.includes("herdr transient output")), false);

  renameSync(transcriptDir, hiddenDir);
  releaseThirdGet.resolve();
  await waitForSignal(fourthGet.promise, "the tick after transient absence");
  renameSync(hiddenDir, transcriptDir);
  appendCompletedResponse(transcriptDir, transcriptName, "herdr completion after transient absence");
  status = "idle";
  releaseFourthGet.resolve();
  await waitForSignal(posted.promise, "the post-absence Herdr response");
  await waitForSignal(fifthGet.promise, "the following Herdr tick");

  assert.equal(
    replies.filter((reply) => reply.includes("herdr transient output")).length,
    1,
    `the retained output should be posted exactly once, got ${JSON.stringify(replies)}`,
  );
  assert.equal(replies.some((reply) => reply.includes("old herdr history")), false);
});


test("a working pane with no turn boundary in its transcript is left running", async () => {
  // The other direction, and the one that must not regress: assistant text with
  // no completion record is a turn still in progress. Reporting it would release
  // the pane mid-turn and drop the rest of the output.
  await withRotationFixture(async ({ tDir, replies, start }) => {
    start();
    await sleep(80);

    writeTranscript(tDir, "session-a.jsonl", ["まだ途中の出力"]);
    await sleep(260);

    assert.deepEqual(replies, [], "silence from herdr plus no boundary means keep waiting");
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

test("a replacement pairing drops collected output and status from the old thread", async () => {
  await withRotationFixture(async ({ tDir, store, replies, setStatus, start }) => {
    start();
    await sleep(80);
    writeTranscript(tDir, "session-a.jsonl", ["old thread output"]);
    await sleep(120); // the watcher collects the response while the pane is working
    assert.equal(replies.length, 0, "working output must remain collected, not posted");

    store.remove(fakePairing().key);
    store.add({
      ...fakePairing(),
      key: "C2:2.2",
      channel: "C2",
      threadTs: "2.2",
    });
    setStatus("idle");
    await sleep(120);

    assert.equal(
      replies.filter((reply) => reply.includes("old thread output")).length,
      0,
      "a response collected for the removed pairing must not be posted to its replacement",
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

test("resuming after a Slack turn never re-reads the transcript that turn reported", async () => {
  // Codex re-review, Critical 3. For a Codex pane the first rollout is created by
  // whichever turn runs first, so a Slack turn creating it is the ordinary case —
  // and then the watcher resumes with both "rebaseline after a turn" and
  // "transcript appeared" true at once. Reading from 0 won that race and the
  // watcher collected everything TurnEngine had just posted, re-posting the lot
  // at the next settle.
  await withRotationFixture(async ({ tDir, replies, setStatus, start, setBusy }) => {
    // The watch has to exist first, with no transcript resolved, which is the
    // state a Codex pane sits in before anything has run in it.
    start();
    await sleep(80);

    setBusy(4); // a Slack turn takes the pane
    writeTranscript(tDir, "session-a.jsonl", ["ターンがSlackに投稿した応答"]);
    await sleep(160); // the turn runs and reports that output itself

    // Now the watcher resumes: rebaseline-after-turn and transcript-appeared are
    // true on the same tick, which is the collision.
    await sleep(120);
    setStatus("idle");
    await sleep(140);

    assert.ok(
      !replies.some((r) => r.includes("ターンがSlackに投稿した応答")),
      `the turn's own output must not be posted again, got ${JSON.stringify(replies)}`,
    );
  });
});

test("a transcript that only failed to resolve for a moment is not read from the start", async () => {
  // Codex re-review, Moderate 1. The locators fold a failed readdir or first-line
  // read into the same null as "not created yet", so "" -> path cannot by itself
  // mean the file is new. Here the file predates watching and merely became
  // visible later; reading it whole would dump an old session into the thread.
  await withRotationFixture(async ({ tDir, replies, setStatus, start, hideTranscript }) => {
    writeTranscript(tDir, "session-a.jsonl", ["ずっと前からある発言"]);
    hideTranscript(true); // resolution fails on the first tick
    start();
    await sleep(80);

    hideTranscript(false); // and succeeds on the next
    await sleep(160);
    setStatus("idle");
    await sleep(140);

    assert.ok(
      !replies.some((r) => r.includes("ずっと前からある発言")),
      `an existing transcript must not be replayed, got ${JSON.stringify(replies)}`,
    );
  });
});

test("a pane whose CLI was quit keeps its pairing", async () => {
  // Codex re-review, Moderate 2 — a hypothesis it could not settle from the
  // repository, confirmed on a live pane: quitting Claude Code leaves the pane at
  // a shell prompt, and `agent get` then answers agent_not_found while `pane get`
  // still returns the pane. Unpairing on the first alone tore the thread down
  // during the very restart that pane-id addressing exists to survive
  // (pairing.ts), so restarting the CLI would have meant reconnecting.
  const dir = mkdtempSync(join(tmpdir(), "cctag-watcher-"));
  try {
    const store = storeWithPairing(dir);
    const { notifier, replies } = fakeNotifier();
    const herdr = fakeTerminals(
      () => null, // no agent...
      () => true, // ...but the pane is still there
    );

    const watcher = new BackgroundWatcher("herdr", herdr, store, idleEngine, notifier, 20);
    watcher.start();
    await sleep(150);
    watcher.stop();

    assert.equal(store.list().length, 1, "the pairing must survive a restart");
    assert.equal(replies.length, 0, "and nothing should be announced in the thread");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a pane that is really gone is still unpaired", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cctag-watcher-"));
  try {
    const store = storeWithPairing(dir);
    const { notifier, replies } = fakeNotifier();
    const herdr = fakeTerminals(
      () => null,
      () => false,
    );

    const watcher = new BackgroundWatcher("herdr", herdr, store, idleEngine, notifier, 20);
    watcher.start();
    await sleep(150);
    watcher.stop();

    assert.equal(store.list().length, 0);
    assert.equal(replies.filter((r) => r.includes("インスタンスが見つかりません")).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an Orca exists:false miss gets restart grace before unpairing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cctag-watcher-orca-grace-"));
  try {
    const store = storeWithPairing(dir, orcaPairing());
    const { notifier, replies } = fakeNotifier();
    let existsCalls = 0;
    const orca = fakeTerminals(
      () => null,
      () => ++existsCalls > 1,
    );
    const watcher = new BackgroundWatcher("orca", orca, store, idleEngine, notifier, 20, 10_000);
    watcher.start();
    await sleep(110);
    watcher.stop();

    assert.ok(existsCalls >= 3, `expected repeated absence checks, got ${existsCalls}`);
    assert.equal(store.list().length, 1, "one false presence result must not drop the Orca pairing");
    assert.deepEqual(replies, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repeated incomplete Orca presence checks do not start absence grace", async () => {
  for (const failingOperation of ["get", "exists"] as const) {
    const dir = mkdtempSync(join(tmpdir(), "cctag-watcher-orca-unavailable-"));
    try {
      const store = storeWithPairing(dir, orcaPairing());
      const { notifier, replies } = fakeNotifier();
      let calls = 0;
      const orca = fakeTerminals(
        async () => {
          calls++;
          if (failingOperation === "get") throw new BackendUnavailable("incomplete terminal list");
          return null;
        },
        async () => {
          calls++;
          if (failingOperation === "exists") throw new BackendUnavailable("incomplete terminal list");
          return false;
        },
      );
      const watcher = new BackgroundWatcher("orca", orca, store, idleEngine, notifier, 20, 40);
      watcher.start();
      await sleep(110);
      watcher.stop();

      assert.equal(store.list().length, 1, `${failingOperation} failure must retain the pairing`);
      assert.ok(calls >= 3, `incomplete presence queries must repeat beyond grace, got ${calls}`);
      assert.deepEqual(replies, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("an Orca pane still missing after the restart grace is unpaired once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cctag-watcher-orca-gone-"));
  try {
    const store = storeWithPairing(dir, orcaPairing());
    const { notifier, replies } = fakeNotifier();
    const watcher = new BackgroundWatcher("orca", fakeTerminals(() => null, () => false), store, idleEngine, notifier, 20, 40);
    watcher.start();
    await sleep(150);
    watcher.stop();

    assert.equal(store.list().length, 0);
    assert.equal(replies.filter((reply) => reply.includes("インスタンスが見つかりません")).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a delayed Herdr check does not delay the independent Orca watcher", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cctag-watcher-independent-"));
  try {
    const store = new PairingStore(join(dir, "pairings.json"));
    store.add(fakePairing());
    store.add(orcaPairing());
    const { notifier } = fakeNotifier();
    let releaseHerdr: (() => void) | undefined;
    const herdrBlocked = new Promise<void>((resolve) => {
      releaseHerdr = resolve;
    });
    let herdrCalls = 0;
    let orcaCalls = 0;
    const herdr = fakeTerminals(async () => {
      herdrCalls++;
      await herdrBlocked;
      throw new BackendUnavailable("delayed Herdr failure");
    });
    const orca = fakeTerminals(
      async () => {
        orcaCalls++;
        return null;
      },
      () => true,
    );
    const herdrWatcher = new BackgroundWatcher("herdr", herdr, store, idleEngine, notifier, 20);
    const orcaWatcher = new BackgroundWatcher("orca", orca, store, idleEngine, notifier, 20, 10_000);
    herdrWatcher.start();
    orcaWatcher.start();
    await sleep(105);
    herdrWatcher.stop();
    orcaWatcher.stop();
    releaseHerdr?.();
    await sleep(10);

    assert.equal(herdrCalls, 1, "the slow backend remains in its first check");
    assert.ok(orcaCalls >= 3, `the other backend must keep ticking, got ${orcaCalls}`);
    assert.equal(store.list().length, 2, "a slow or failing watcher must not unpair either target");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- a file handed over once, not once per settle ---------------------------
//
// Driven entirely by the transcript, with herdr pinned to `working`: settle.ts
// corrects a `working` the transcript has already closed out, so appending a
// turn's `user` record reopens the turn and appending its `turn_duration` closes
// it. Flipping herdr's own status instead does not work — the correction
// overrides it, which is how an earlier version of this test came to pass
// without the fix in place.

const TURN_START = {
  type: "user",
  timestamp: "2026-09-27T14:48:48.520Z",
  message: { role: "user", content: "やって" },
};

function turnEnd(text: string): unknown[] {
  return [
    {
      type: "assistant",
      timestamp: "2026-09-27T14:48:53.416Z",
      message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text }] },
    },
    { type: "system", subtype: "turn_duration", timestamp: "2026-09-27T14:49:01.083Z", durationMs: 1234 },
  ];
}

function sendUserFile(path: string, id: string): unknown[] {
  return [
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id, name: "SendUserFile", input: { files: [path], caption: "できました" } }],
      },
    },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } },
  ];
}

function appendRecords(dir: string, name: string, records: unknown[]): void {
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, name), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

/** Records every set of confirmed files handed to an upload. */
function uploadRecordingEngine(): { engine: TurnEngine; handovers: string[][] } {
  const handovers: string[][] = [];
  const engine = {
    isBusy: () => false,
    async adoptBlockedTerminal() {
      return false;
    },
    async uploadOutboxAdditions(
      _pairing: unknown,
      _cwd: string,
      baseline: Record<string, number>,
      confirmed: Array<{ path: string }>,
    ) {
      handovers.push(confirmed.map((c) => c.path));
      return baseline;
    },
  } as unknown as TurnEngine;
  return { engine, handovers };
}
test("an OMP transcript read is discarded when its process binding is lost", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cctag-omp-watch-loss-"));
  let watcher: BackgroundWatcher | undefined;
  try {
    const cwd = join(dir, "cwd");
    mkdirSync(cwd);
    const transcriptPath = join(dir, "omp-session.jsonl");
    writeFileSync(transcriptPath, "");
    const sessionId = "9a51b84e-610c-4d9e-bb20-28d7c850c552";
    const agent = fakeOmpAgent(transcriptPath, sessionId, cwd);
    const pairing = { ...orcaPairing(), cwd };
    const store = new PairingStore(join(dir, "pairings.json"));
    store.add(pairing);
    const { notifier, replies } = fakeNotifier();
    let gets = 0;
    const terminals = fakeTerminals(
      () => {
        gets++;
        return gets <= 2 ? agent : null;
      },
      () => true,
    );
    watcher = new BackgroundWatcher("orca", terminals, store, idleEngine, notifier, 160);
    watcher.start();
    await sleep(210); // let the first tick establish its baseline
    assert.equal(gets, 1);

    appendRecords(dir, "omp-session.jsonl", [
      {
        type: "message",
        timestamp: "2026-09-28T22:53:55.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "must not be posted" }] },
      },
    ]);
    await sleep(300);
    watcher.stop();

    assert.ok(gets >= 3, "the read must be followed by an ownership lookup");
    assert.equal(replies.filter((reply) => reply === OMP_RESUME_NOTICE).length, 1);
    assert.equal(replies.some((reply) => reply.includes("must not be posted")), false);
    assert.equal(store.list().length, 1, "binding loss does not discard the pairing");
  } finally {
    watcher?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("watcher waits for two complete OMP screens before handing off a terminal-only notice", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cctag-omp-watch-screen-"));
  let watcher: BackgroundWatcher | undefined;
  try {
    const cwd = join(dir, "cwd");
    mkdirSync(cwd);
    const transcriptPath = join(dir, "omp-session.jsonl");
    writeFileSync(transcriptPath, "");
    const sessionId = "9a51b84e-610c-4d9e-bb20-28d7c850c552";
    const agent = fakeOmpAgent(transcriptPath, sessionId, cwd);
    const pairing = { ...orcaPairing(), cwd };
    const store = new PairingStore(join(dir, "pairings.json"));
    store.add(pairing);
    const waiting = capturedOmpScreen("ask-open.screen.json");
    const expectedNotice = formatOmpScreenNotice(waiting);
    const expectedFingerprint = ompScreenFingerprint(waiting);
    assert.ok(expectedNotice);
    assert.ok(expectedFingerprint);
    const terminals = fakeTerminals(() => agent);
    terminals.read = async () => waiting;
    const handoffs: Array<Parameters<TurnEngine["adoptBlockedTerminal"]>[1]> = [];
    const engine = {
      isBusy: () => false,
      async adoptBlockedTerminal(_pairing: Pairing, handoff: (typeof handoffs)[number]) {
        handoffs.push(handoff);
        return true;
      },
    } as unknown as TurnEngine;
    const { notifier } = fakeNotifier();
    watcher = new BackgroundWatcher("orca", terminals, store, engine, notifier, 20);
    watcher.start();
    await sleep(45); // establish the transcript baseline before adding a new turn
    appendRecords(dir, "omp-session.jsonl", [
      {
        type: "message",
        timestamp: "2026-09-28T22:53:55.000Z",
        message: { role: "user", content: [{ type: "text", text: "new request" }] },
      },
    ]);
    for (let i = 0; i < 40 && handoffs.length === 0; i++) await sleep(5);
    watcher.stop();

    assert.equal(handoffs.length, 1);
    assert.equal(handoffs[0]!.ompStatus?.waitingSamples, 2);
    assert.equal(handoffs[0]!.ompStatus?.noticeFingerprint, null);
    assert.equal(handoffs[0]!.ompNotice, expectedNotice);
    assert.equal(handoffs[0]!.ompFingerprint, expectedFingerprint);
  } finally {
    watcher?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an established OMP session switch baselines at EOF without replaying history", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cctag-omp-watch-switch-"));
  let watcher: BackgroundWatcher | undefined;
  try {
    const cwd = join(dir, "cwd");
    mkdirSync(cwd);
    const firstPath = join(dir, "omp-first.jsonl");
    const secondPath = join(dir, "omp-second.jsonl");
    writeFileSync(firstPath, "");
    const firstId = "9a51b84e-610c-4d9e-bb20-28d7c850c552";
    const secondId = "291665fa-c79d-4ddb-a952-c2f947fa6d88";
    let current = fakeOmpAgent(firstPath, firstId, cwd, "1", "11");
    const store = new PairingStore(join(dir, "pairings.json"));
    const pairing = { ...orcaPairing(), cwd };
    store.add(pairing);
    const { notifier, replies } = fakeNotifier();
    const { engine } = uploadRecordingEngine();
    const terminals = fakeTerminals(() => current);
    terminals.read = async () => capturedOmpScreen("idle.screen.json");
    watcher = new BackgroundWatcher("orca", terminals, store, engine, notifier, 50);
    watcher.start();
    await sleep(80);

    appendRecords(dir, "omp-second.jsonl", [
      {
        type: "message",
        timestamp: "2026-09-28T22:53:54.000Z",
        message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "stale history" }] },
      },
    ]);
    current = fakeOmpAgent(secondPath, secondId, cwd, "1", "22");
    await sleep(80); // the changed file is established at its current EOF
    assert.equal(store.list().length, 1);
    assert.equal(replies.some((reply) => reply.includes("stale history")), false);

    appendRecords(dir, "omp-second.jsonl", [
      {
        type: "message",
        timestamp: "2026-09-28T22:54:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "new request" }] },
      },
      {
        type: "message",
        timestamp: "2026-09-28T22:54:01.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "fresh session output" }] },
      },
    ]);
    await sleep(80);
    appendRecords(dir, "omp-second.jsonl", [
      {
        type: "message",
        timestamp: "2026-09-28T22:54:02.000Z",
        message: { role: "assistant", stopReason: "stop", content: [] },
      },
    ]);
    for (let i = 0; i < 30 && !replies.some((reply) => reply.includes("fresh session output")); i++) {
      await sleep(20);
    }
    watcher.stop();

    assert.equal(store.list().length, 1, "session rotation keeps its pane pairing");
    assert.equal(replies.some((reply) => reply.includes("stale history")), false);
    assert.equal(
      replies.filter((reply) => reply.includes("fresh session output")).length,
      1,
    );
  } finally {
    watcher?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});


test("an OMP inode replacement discards the read batch and rebaselines at the replacement EOF", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cctag-omp-watch-inode-"));
  let watcher: BackgroundWatcher | undefined;
  try {
    const cwd = join(dir, "cwd");
    mkdirSync(cwd);
    const transcriptPath = join(dir, "omp-session.jsonl");
    writeFileSync(transcriptPath, "");
    const sessionId = "9a51b84e-610c-4d9e-bb20-28d7c850c552";
    const oldAgent = fakeOmpAgent(transcriptPath, sessionId, cwd, "1", "11");
    const replacement = fakeOmpAgent(transcriptPath, sessionId, cwd, "1", "22");
    const pairing = { ...orcaPairing(), cwd };
    const store = new PairingStore(join(dir, "pairings.json"));
    store.add(pairing);
    const { notifier, replies } = fakeNotifier();
    let gets = 0;
    const terminals = fakeTerminals(
      () => {
        gets++;
        return gets <= 2 ? oldAgent : replacement;
      },
      () => true,
    );
    terminals.read = async () => capturedOmpScreen("idle.screen.json");
    const { engine } = uploadRecordingEngine();
    watcher = new BackgroundWatcher("orca", terminals, store, engine, notifier, 50);
    watcher.start();
    await sleep(80);

    renameSync(transcriptPath, join(dir, "omp-session-old-inode.jsonl"));
    appendRecords(dir, "omp-session.jsonl", [
      {
        type: "message",
        timestamp: "2026-09-28T22:54:10.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "replaced transcript history" }] },
      },
    ]);
    await sleep(80); // read the replacement, then reject it when its inode differs
    assert.equal(replies.some((reply) => reply.includes("replaced transcript history")), false);
    assert.equal(replies.includes(OMP_RESUME_NOTICE), false, "a new valid inode is a switch, not a quit");
    assert.equal(store.list().length, 1);

    appendRecords(dir, "omp-session.jsonl", [
      {
        type: "message",
        timestamp: "2026-09-28T22:54:11.000Z",
        message: { role: "user", content: [{ type: "text", text: "new request" }] },
      },
      {
        type: "message",
        timestamp: "2026-09-28T22:54:12.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "replacement output" }] },
      },
    ]);
    await sleep(80);
    appendRecords(dir, "omp-session.jsonl", [
      {
        type: "message",
        timestamp: "2026-09-28T22:54:13.000Z",
        message: { role: "assistant", stopReason: "stop", content: [] },
      },
    ]);
    for (let i = 0; i < 30 && !replies.some((reply) => reply.includes("replacement output")); i++) {
      await sleep(20);
    }
    watcher.stop();

    assert.equal(replies.some((reply) => reply.includes("replaced transcript history")), false);
    assert.equal(replies.filter((reply) => reply.includes("replacement output")).length, 1);
    assert.equal(store.list().length, 1);
  } finally {
    watcher?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Orca hint working-to-idle transition posts terminal output and file additions", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cctag-orca-watch-"));
  const tDir = transcriptDirFor(cwd);
  const storeDir = mkdtempSync(join(tmpdir(), "cctag-orca-watch-store-"));
  const filePath = join(cwd, "report.pdf");
  let watcher: BackgroundWatcher | undefined;
  let screenReads = 0;
  try {
    writeFileSync(filePath, "report");
    const store = new PairingStore(join(storeDir, "pairings.json"));
    store.add({ ...fakePairing(), cwd, paneId: ORCA_PANE, backend: "orca" });
    const { notifier, replies } = fakeNotifier();
    const { engine, handovers } = uploadRecordingEngine();
    const agent: AgentInfo = {
      ...fakeAgent("working", cwd),
      ref: { target: ORCA_PANE, pid: 42, processStartedAt: 1 },
      backend: "orca" as const,
      sessionId: null,
      evidence: { kind: "hint" as const, state: "working", waitingSince: null },
    };
    const terminals: Terminals = {
      ...fakeTerminals(() => agent),
      async read() {
        screenReads++;
        return { text: "", draft: null, complete: true };
      },
    };
    watcher = new BackgroundWatcher("orca", terminals, store, engine, notifier, 20);
    watcher.start();
    await sleep(80); // first sight establishes the transcript baseline

    appendRecords(tDir, "session-a.jsonl", [
      TURN_START,
      {
        type: "assistant",
        timestamp: "2026-09-27T14:48:53.416Z",
        message: { role: "assistant", content: [{ type: "text", text: "terminal response" }] },
      },
      ...sendUserFile(filePath, "toolu_orca_1"),
    ]);
    for (let i = 0; i < 20 && screenReads === 0; i++) await sleep(20);
    assert.ok(screenReads > 0, "the running transcript must reach the complete-screen row");

    appendRecords(tDir, "session-a.jsonl", [turnEnd("terminal response")[1]]);
    for (let i = 0; i < 20 && !replies.some((reply) => reply.includes("terminal response")); i++) {
      await sleep(20);
    }
    watcher.stop();

    assert.equal(
      replies.filter((reply) => reply.includes("terminal response")).length,
      1,
      "the saved working status must trigger one terminal-side response on idle",
    );
    assert.deepEqual(handovers, [[filePath]], "file additions must be handed over on the same transition");
  } finally {
    watcher?.stop();
    rmSync(tDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(storeDir, { recursive: true, force: true });
  }
});

test("a file already uploaded is not handed over again on the next settle", async () => {
  // Reported from a production thread: the same files kept arriving, and the
  // counts gave the mechanism away — the oldest file posted 13 times, the next
  // 6, the next 4. Cumulative, not random. BackgroundWatcher keeps one
  // WrittenFileTracker per watched pane and uploads on every settle, and nothing
  // cleared the confirmed set, so each settle re-sent everything confirmed since
  // the watch began. `collected` was emptied and `outboxBaseline` advanced right
  // beside it; only the writes were not.
  const dir = mkdtempSync(join(tmpdir(), "cctag-watcher-"));
  const cwd = mkdtempSync(join(tmpdir(), "cctag-cwd-"));
  const tDir = transcriptDirFor(cwd);
  const filePath = join(cwd, "report.pdf");
  try {
    const store = new PairingStore(join(dir, "pairings.json"));
    store.add({ ...fakePairing(), cwd });
    const { notifier } = fakeNotifier();
    const { engine, handovers } = uploadRecordingEngine();
    const watcher = new BackgroundWatcher("herdr", rotatingTerminals(cwd, () => "working"), store, engine, notifier, 20);

    // Written only after the watch exists: a transcript that was already there
    // when watching began is deliberately never replayed.
    watcher.start();
    await sleep(100);
    appendRecords(tDir, "session-a.jsonl", [
      TURN_START,
      ...sendUserFile(filePath, "toolu_1"),
      ...turnEnd("一つ目の結果"),
    ]);
    await sleep(100); // settle 1 — the file is handed over here

    appendRecords(tDir, "session-a.jsonl", [TURN_START]); // a second stretch of work begins
    await sleep(100);
    appendRecords(tDir, "session-a.jsonl", turnEnd("二つ目の結果")); // ... and settles
    await sleep(100);
    watcher.stop();

    const times = handovers.filter((h) => h.includes(filePath)).length;
    assert.equal(times, 1, `report.pdf should be handed over once, not ${times}: ${JSON.stringify(handovers)}`);
    assert.ok(handovers.length >= 2, `both settles must have been seen, saw ${handovers.length}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(tDir, { recursive: true, force: true });
  }
});

test("watcher ownership follows target prefixes despite mismatched persisted tags", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cctag-watcher-prefix-"));
  try {
    const orca = { ...orcaPairing() };
    delete orca.backend;
    const herdr: Pairing = {
      ...fakePairing(),
      key: "C1:3.1",
      threadTs: "3.1",
      paneId: "wH:p2",
      backend: "orca",
    };
    const pairings = [orca, herdr];
    let removals = 0;
    const store = {
      list: () => pairings,
      remove: () => {
        removals++;
        return true;
      },
    } as unknown as PairingStore;
    const { notifier, replies } = fakeNotifier();
    const configurations: Array<Array<"herdr" | "orca">> = [["orca"], ["herdr"], ["herdr", "orca"]];

    for (const enabled of configurations) {
      const calls: Record<"herdr" | "orca", string[]> = { herdr: [], orca: [] };
      const watchers = enabled.map((backend) =>
        new BackgroundWatcher(
          backend,
          fakeTerminals((target) => {
            calls[backend].push(target);
            return null;
          }),
          store,
          idleEngine,
          notifier,
          5,
          60_000,
        ),
      );
      try {
        watchers.forEach((watcher) => watcher.start());
        await sleep(40);
      } finally {
        watchers.forEach((watcher) => watcher.stop());
      }

      assert.deepEqual([...new Set(calls.herdr)].sort(), enabled.includes("herdr") ? ["wH:p2"] : []);
      assert.deepEqual([...new Set(calls.orca)].sort(), enabled.includes("orca") ? [ORCA_PANE] : []);
    }

    assert.equal(removals, 0);
    assert.deepEqual(replies, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
