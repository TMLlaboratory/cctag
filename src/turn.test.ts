import { test } from "node:test";
import assert from "node:assert/strict";
import { TurnEngine } from "./turn.js";
import { HerdrBackend } from "./backend/herdr.js";
import type { AnswerChannel, Terminals } from "./backend/index.js";
import {
  ExpectationLost,
  SubmitRefused,
  UNSENDABLE_TEXT_MESSAGE,
  WriteOutcomeUnknown,
  type AgentInfo,
  type AgentStatus,
  type BackendName,
  type ScreenSnapshot,
} from "./backend/types.js";
import type { Pairing } from "./pairing.js";
import type { MessageHandle, Notifier } from "./notifier.js";
import { claudeDriver } from "./agents/claude/driver.js";
import { ompDriver, OMP_RESUME_NOTICE } from "./agents/omp/driver.js";
import { formatOmpScreenNotice, ompScreenFingerprint } from "./agents/omp/prompts.js";
import { WrittenFileTracker } from "./attachments.js";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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

function fakeAgent(status: AgentStatus, backend: BackendName = "herdr"): AgentInfo {
  return {
    ref: { target: PANE, pid: null, processStartedAt: null },
    backend,
    agent: "claude",
    sessionId: "s1",
    cwd: "/tmp/nonexistent-cctag-test",
    evidence: { kind: "classified", status },
    terminalId: "herdr-terminal-id",
    terminalTitle: null,
    displayId: PANE,
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

/** Records posted messages and button blocks so tests use the issued prompt ID. */
function fakeNotifier(): {
  notifier: Notifier;
  posts: string[];
  postedBlocks: unknown[][];
  updates: Array<{ text: string; blocks: unknown[] }>;
} {
  const posts: string[] = [];
  const postedBlocks: unknown[][] = [];
  const updates: Array<{ text: string; blocks: unknown[] }> = [];
  const handle: MessageHandle = {
    async update(text, blocks) {
      updates.push({ text, blocks: blocks ?? [] });
    },
  };
  const notifier: Notifier = {
    async postReply(_c, _t, text) {
      posts.push(text);
    },
    async postMessage(_c, _t, text, blocks) {
      posts.push(text);
      postedBlocks.push(blocks ?? []);
      return handle;
    },
  };
  return { notifier, posts, postedBlocks, updates };
}

function promptIdInButtonBlock(value: unknown): number | undefined {
  if (Array.isArray(value)) {
    for (const child of value) {
      const id = promptIdInButtonBlock(child);
      if (id !== undefined) return id;
    }
    return undefined;
  }
  if (value === null || typeof value !== "object") return undefined;
  if ("value" in value && typeof value.value === "string") {
    let payload: unknown;
    try {
      payload = JSON.parse(value.value);
    } catch {
      payload = undefined;
    }
    if (
      payload !== null &&
      typeof payload === "object" &&
      "p" in payload &&
      typeof payload.p === "number" &&
      Number.isSafeInteger(payload.p)
    ) {
      return payload.p;
    }
  }
  for (const child of Object.values(value)) {
    const id = promptIdInButtonBlock(child);
    if (id !== undefined) return id;
  }
  return undefined;
}

function promptIdFromPostedBlocks(postedBlocks: unknown[][]): number {
  for (let i = postedBlocks.length - 1; i >= 0; i--) {
    const id = promptIdInButtonBlock(postedBlocks[i]);
    if (id !== undefined) return id;
  }
  throw new Error("no prompt button was posted");
}

type FakeBackend = Terminals;

function fakeAnswerChannel(overrides: Partial<AnswerChannel> = {}): AnswerChannel {
  return {
    async digit(n, terminal) {
      await overrides.digit?.(n, terminal);
    },
    async text(value) {
      await overrides.text?.(value);
    },
    async move(direction, count) {
      await overrides.move?.(direction, count);
    },
    async confirm(expectedLabel, terminal) {
      await overrides.confirm?.(expectedLabel, terminal);
    },
    complete() {
      overrides.complete?.();
    },
  };
}

function fakeBackend(
  status: () => AgentStatus,
  pane: () => string = () => PERMISSION_PANE,
  overrides: Partial<FakeBackend> = {},
  backendName: BackendName = "herdr",
): FakeBackend {
  return {
    async list() {
      return {
        agents: [],
        failures: [{ backend: "herdr", reason: "not implemented by test fake" }],
        complete: false,
        notices: [],
      };
    },
    async get() {
      return fakeAgent(status(), backendName);
    },
    async exists() {
      return true;
    },
    async read() {
      return { text: pane(), draft: null, complete: true };
    },
    async submit() {
      return { status: "accepted", draftStashed: false };
    },
    openAnswer() {
      return fakeAnswerChannel();
    },
    openModelAnswer() {
      return {
        ...fakeAnswerChannel(),
        async escape() {},
      };
    },
    openBlind() {
      return { async answer() {} };
    },
    openComposer() {
      return { async backTab() {} };
    },
    ...overrides,
  };
}

function fakeHerdr(status: () => AgentStatus, pane: () => string = () => PERMISSION_PANE): FakeBackend {
  return fakeBackend(status, pane);
}

function engineFor(herdr: FakeBackend, notifier: Notifier, turnTimeoutMs: number): TurnEngine {
  return new TurnEngine(
    herdr,
    notifier,
    { turnTimeoutMs, pollIntervalMs: 5, limits: { maxFileBytes: 1024, maxFileCount: 1 } },
    { list: () => [fakePairing()] },
  );
}

function adopt(engine: TurnEngine, pairing: Pairing, backend: BackendName = "herdr"): Promise<boolean> {
  return engine.adoptBlockedTerminal(pairing, {
    backend,
    driver: claudeDriver,
    sessionId: "s1",
    transcriptPath: "",
    offset: 0,
    collected: [],
    paneId: PANE,
    ref: fakeAgent("blocked", backend).ref,
    cwd: "/tmp/nonexistent-cctag-test",
    outboxBaseline: {},
    writes: new WrittenFileTracker(),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Synthetic Claude transcript records for lifecycle tests; no CLI is invoked.
function completedClaudeTurn(startedAt: string, text: string): Array<Record<string, unknown>> {
  const start = Date.parse(startedAt);
  return [
    {
      type: "user",
      timestamp: new Date(start).toISOString(),
      message: { role: "user", content: "continue" },
    },
    {
      type: "assistant",
      timestamp: new Date(start + 1_000).toISOString(),
      message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text }] },
    },
    {
      type: "system",
      subtype: "turn_duration",
      timestamp: new Date(start + 2_000).toISOString(),
      durationMs: 1_000,
    },
  ];
}

function writeClaudeTurn(path: string, startedAt: string, text: string, append = false): void {
  const data = `${completedClaudeTurn(startedAt, text).map((record) => JSON.stringify(record)).join("\n")}\n`;
  if (append) appendFileSync(path, data);
  else writeFileSync(path, data);
}

test("a stashed Orca draft is reported in the thread after submission", async () => {
  const target = `orca:${PANE}`;
  const pairing: Pairing = { ...fakePairing(), paneId: target, backend: "orca" };
  const { notifier, posts } = fakeNotifier();
  const terminals = fakeBackend(
    () => "working",
    () => "",
    {
      async get(receivedTarget) {
        return {
          ...fakeAgent("working", "orca"),
          ref: { target: receivedTarget, pid: 42, processStartedAt: 1 },
        };
      },
      async submit() {
        return { status: "accepted", draftStashed: true };
      },
    },
    "orca",
  );
  const engine = engineFor(terminals, notifier, 600_000);

  try {
    await engine.startTurn(pairing, "U1", "send this");
    assert.ok(posts.includes(
      "📥 orca の入力欄の書きかけを一時退避して送りました。Claude Code 2.1.287 では送信の後に入力欄へ戻ります。戻っていなければ、入力欄が空（打った文字も灰色の提案も無い）のときに Ctrl+S を押すと戻ります。",
    ));
  } finally {
    engine.abortAll();
  }
});

test("turn refusal is reported once, in its status message, with probe and stash uncertainty", async () => {
  const target = `orca:${PANE}`;
  const pairing: Pairing = { ...fakePairing(), paneId: target, backend: "orca" };
  const { notifier, posts, updates } = fakeNotifier();
  const composer = { probe: "x", stash: "uncertain", submitUncertain: false } as const;
  const terminals = fakeBackend(
    () => "working",
    () => "",
    {
      async get(receivedTarget) {
        return {
          ...fakeAgent("working", "orca"),
          ref: { target: receivedTarget, pid: 42, processStartedAt: 1 },
        };
      },
      async submit() {
        throw new SubmitRefused("stash-unverified", "internal refusal", composer);
      },
    },
    "orca",
  );
  const engine = engineFor(terminals, notifier, 600_000);

  try {
    await engine.startTurn(pairing, "U1", "send this");
    assert.deepEqual(posts, ["⚙️ 実行中…"]);
    assert.equal(engine.isBusy(target), false);
    assert.deepEqual(updates.map(({ text }) => text), [
      "⚠️ orca の入力欄の書きかけを Ctrl+S で退避しようとしましたが、送れる状態か確かめられなかったため、送信していません。 確かめのために打った `x` が入力欄に1文字残っているかもしれません。 書きかけが Ctrl+S で退避されたかどうかを確かめられませんでした。端末で入力欄を見てください。入力欄に文字があるときに Ctrl+S を押すと、その文字が退避され、前に退避したものは消えます。",
    ]);
  } finally {
    engine.abortAll();
  }
});

test("an accepted Orca turn ignores a historical completion until its own transcript boundary", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cctag-orca-stale-end-"));
  const sessionId = "session-stale-end";
  const transcriptPath = claudeDriver.locateTranscript(cwd, sessionId);
  assert.ok(transcriptPath);
  const transcriptDir = dirname(transcriptPath);
  mkdirSync(transcriptDir, { recursive: true });
  writeClaudeTurn(transcriptPath, "2026-09-28T10:00:00.000Z", "old transcript output");

  const target = `orca:${PANE}`;
  const pairing: Pairing = { ...fakePairing(), paneId: target, backend: "orca" };
  const { notifier, posts, updates } = fakeNotifier();
  let submitted = false;
  let pollCount = 0;
  let seeFirstPoll!: () => void;
  const firstPoll = new Promise<void>((resolve) => (seeFirstPoll = resolve));
  const terminals = fakeBackend(
    () => "working",
    () => "",
    {
      async get(receivedTarget) {
        if (submitted && pollCount++ === 0) seeFirstPoll();
        return {
          ...fakeAgent(submitted ? "working" : "idle", "orca"),
          ref: { target: receivedTarget, pid: 42, processStartedAt: 1 },
          sessionId,
          cwd,
          evidence: { kind: "hint", state: "done", waitingSince: null },
        };
      },
      async submit() {
        submitted = true;
        return { status: "accepted", draftStashed: false };
      },
    },
    "orca",
  );
  const engine = new TurnEngine(
    terminals,
    notifier,
    { turnTimeoutMs: 600_000, pollIntervalMs: 100, limits: { maxFileBytes: 1024, maxFileCount: 1 } },
    { list: () => [pairing] },
  );

  try {
    await engine.startTurn(pairing, "U1", "new prompt");
    await firstPoll;
    await sleep(20); // Let that poll resolve, but stay before the next interval.

    assert.ok(updates.some(({ text }) => text.includes("orca は入力を受け付けました")));
    assert.equal(engine.isBusy(target), true, "a historical completion and done hint must not release a fresh turn");
    assert.equal(
      updates.some(({ text }) => text.startsWith("✅")),
      false,
      "no completed status is posted before this turn writes a boundary",
    );
    assert.equal(posts.some((post) => post.includes("old transcript output")), false);

    writeClaudeTurn(transcriptPath, "2026-09-28T10:00:05.000Z", "new turn response", true);
    for (let i = 0; i < 50; i++) {
      if (!engine.isBusy(target) && posts.join("\n").includes("new turn response")) break;
      await sleep(20);
    }

    assert.equal(engine.isBusy(target), false, "the newly observed completion should release the turn");
    assert.ok(posts.some((post) => post.includes("new turn response")), JSON.stringify(posts));
  } finally {
    engine.abortAll();
    rmSync(transcriptDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a new session does not inherit a blocked status on an incomplete screen", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cctag-session-reset-"));
  let transcriptDir = "";
  let engine: TurnEngine | undefined;
  let reads = 0;
  const { notifier } = fakeNotifier();
  try {
    const transcriptPath = claudeDriver.locateTranscript(cwd, "session-new");
    assert.ok(transcriptPath);
    transcriptDir = dirname(transcriptPath);
    mkdirSync(transcriptDir, { recursive: true });
    writeFileSync(
      transcriptPath,
      `${JSON.stringify({
        type: "user",
        timestamp: "2026-09-27T14:48:48.520Z",
        message: { role: "user", content: "new session" },
      })}\n`,
    );

    const terminals = fakeBackend(() => "working", () => "", {
      async get(): Promise<AgentInfo> {
        return {
          ...fakeAgent("working"),
          backend: "orca",
          sessionId: "session-new",
          cwd,
          evidence: { kind: "hint", state: "working", waitingSince: null },
        };
      },
      async read() {
        reads++;
        return { text: "partial screen", draft: null, complete: false };
      },
    });
    engine = new TurnEngine(
      terminals,
      notifier,
      { turnTimeoutMs: 600_000, pollIntervalMs: 200, limits: { maxFileBytes: 1024, maxFileCount: 1 } },
      { list: () => [fakePairing()] },
    );

    const adopted = await engine.adoptBlockedTerminal(fakePairing(), {
      backend: "herdr",
      driver: claudeDriver,
      sessionId: "session-old",
      transcriptPath: "",
      offset: 0,
      collected: [],
      paneId: PANE,
      ref: fakeAgent("blocked").ref,
      cwd,
      outboxBaseline: {},
      writes: new WrittenFileTracker(),
    });
    assert.equal(adopted, true);
    for (let i = 0; i < 30 && reads === 0; i++) await sleep(20);
    await sleep(20); // let a stale blocked status enter its prompt-read path
    assert.equal(reads, 1, "the new session must not reuse the old session's blocked status");
  } finally {
    engine?.abortAll();
    if (transcriptDir) rmSync(transcriptDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

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
  // Codex review, Critical 5. Herdr's `Terminals.get()` returns null only for its own "no
  // such pane"; a timeout or spawn failure throws. Treating the two alike killed
  // turns whose agent was still working, and released the pane to a watcher that
  // rebaselines — losing the rest of the output. Uses a `working` pane so the
  // loop keeps its fast interval and the failures actually get reached.
  const { notifier, posts } = fakeNotifier();
  let calls = 0;
  const herdr = fakeBackend(() => "working", () => PERMISSION_PANE, {
    async get() {
      calls += 1;
      if (calls === 2 || calls === 3) throw new Error("herdr command timed out");
      return fakeAgent("working");
    },
  });
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
  const herdr = fakeBackend(() => "blocked", () => PERMISSION_PANE, {
    async get(): Promise<AgentInfo | null> {
      throw new Error("herdr command timed out");
    },
  });
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
  const { notifier, postedBlocks } = fakeNotifier();
  const sent: string[] = [];
  const herdr = fakeBackend(() => "blocked", () => PERMISSION_PANE, {
    // Slow enough that the second click arrives while the first is in
    // flight — the real race, rather than a simulated one.
    openAnswer() {
      return fakeAnswerChannel({
        async digit(n) {
          await sleep(40);
          sent.push(String(n));
        },
      });
    },
  });
  const engine = engineFor(herdr, notifier, 600_000);

  try {
    await adopt(engine, fakePairing());
    await sleep(200); // prompt posted before reading its button value
    const promptId = promptIdFromPostedBlocks(postedBlocks);
    const pairingKey = fakePairing().key;

    const first = engine.answerPermissionButton(PANE, promptId, "1", pairingKey);
    const second = await engine.answerPermissionButton(PANE, promptId, "1", pairingKey);
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
  const { notifier, postedBlocks } = fakeNotifier();
  let attempts = 0;
  const herdr = fakeBackend(() => "blocked", () => PERMISSION_PANE, {
    openAnswer() {
      return fakeAnswerChannel({
        async digit() {
          attempts += 1;
          if (attempts === 1) throw new Error("send-text failed");
        },
      });
    },
  });
  const engine = engineFor(herdr, notifier, 600_000);

  try {
    await adopt(engine, fakePairing());
    await sleep(200);
    const promptId = promptIdFromPostedBlocks(postedBlocks);
    const pairingKey = fakePairing().key;

    await assert.rejects(engine.answerPermissionButton(PANE, promptId, "1", pairingKey), /send-text failed/);
    const retry = await engine.answerPermissionButton(PANE, promptId, "1", pairingKey);
    assert.deepEqual(retry, { ok: true }, "the same prompt must still be answerable after a failure");
    assert.equal(attempts, 2);
  } finally {
    engine.abortAll();
  }
});
test("Orca unknown answer outcome retires the prompt and refuses the same button", async () => {
  const warning = "送信できたか確認できません。端末を確かめてください";
  const { notifier, postedBlocks, updates } = fakeNotifier();
  let acceptedWrites = 0;
  const terminals = fakeBackend(
    () => "blocked",
    () => PERMISSION_PANE,
    {
      openAnswer() {
        return fakeAnswerChannel({
          async digit() {
            acceptedWrites++;
            throw new WriteOutcomeUnknown();
          },
        });
      },
    },
    "orca",
  );
  const engine = engineFor(terminals, notifier, 600_000);

  try {
    await adopt(engine, fakePairing(), "orca");
    await sleep(200);
    const promptId = promptIdFromPostedBlocks(postedBlocks);
    const pairingKey = fakePairing().key;

    assert.deepEqual(
      await engine.answerPermissionButton(PANE, promptId, "1", pairingKey),
      { ok: true },
    );
    assert.equal(acceptedWrites, 1);
    const warningUpdate = updates.find((update) => update.text === warning);
    assert.ok(warningUpdate, "the prompt message carries the uncertainty warning");
    assert.deepEqual(warningUpdate.blocks, [], "the old answer buttons are removed");

    assert.deepEqual(
      await engine.answerPermissionButton(PANE, promptId, "1", pairingKey),
      { ok: false, reason: "not-pending" },
    );
    assert.equal(acceptedWrites, 1, "the same button cannot send a second time");
  } finally {
    engine.abortAll();
  }
});

test("Orca pre-write answer refusal leaves the button retryable", async () => {
  const { notifier, postedBlocks } = fakeNotifier();
  let attempts = 0;
  const terminals = fakeBackend(
    () => "blocked",
    () => PERMISSION_PANE,
    {
      openAnswer() {
        return fakeAnswerChannel({
          async digit() {
            attempts++;
            if (attempts === 1) throw new ExpectationLost("process changed before send");
          },
        });
      },
    },
    "orca",
  );
  const engine = engineFor(terminals, notifier, 600_000);

  try {
    await adopt(engine, fakePairing(), "orca");
    await sleep(200);
    const promptId = promptIdFromPostedBlocks(postedBlocks);
    const pairingKey = fakePairing().key;

    await assert.rejects(
      engine.answerPermissionButton(PANE, promptId, "1", pairingKey),
      ExpectationLost,
    );
    assert.deepEqual(
      await engine.answerPermissionButton(PANE, promptId, "1", pairingKey),
      { ok: true },
    );
    assert.equal(attempts, 2);
  } finally {
    engine.abortAll();
  }
});

test("Orca plan feedback rejects C0 text before selecting an answer", async () => {
  const { notifier } = fakeNotifier();
  const planPane = [
    "Claude has written up a plan and is ready to execute. Would you like to proceed?",
    "",
    "   ❯ 1. Yes, and use auto mode",
    "     2. Yes, manually approve edits",
    "     3. Tell Claude what to change",
  ].join("\n");
  let writes = 0;
  const terminals = fakeBackend(
    () => "blocked",
    () => planPane,
    {
      openAnswer() {
        return fakeAnswerChannel({
          async digit() {
            writes++;
          },
          async text() {
            writes++;
          },
          async confirm() {
            writes++;
          },
        });
      },
    },
    "orca",
  );
  const engine = engineFor(terminals, notifier, 600_000);

  try {
    await adopt(engine, fakePairing(), "orca");
    await sleep(200);
    await assert.rejects(
      engine.answerPlanFeedback(PANE, "\u001b[A\r"),
      (error: unknown) => error instanceof ExpectationLost && error.userMessage?.includes("制御文字"),
    );
    assert.equal(writes, 0);
  } finally {
    engine.abortAll();
  }
});


test("Orca rejects original C0 text before downloading attachments", async () => {
  const target = `orca:${PANE}`;
  const pairing: Pairing = { ...fakePairing(), paneId: target, backend: "orca" };
  let downloads = 0;
  const submitted: string[] = [];
  const terminals = fakeBackend(
    () => "idle",
    () => "",
    {
      async get(receivedTarget) {
        return {
          ...fakeAgent("idle", "orca"),
          ref: { target: receivedTarget, pid: 42, processStartedAt: 1 },
          sessionId: null,
        };
      },
      async submit(_ref, text) {
        submitted.push(text);
        return { status: "accepted", draftStashed: false };
      },
    },
    "orca",
  );
  const { notifier, posts } = fakeNotifier();
  const withFiles: Notifier = {
    ...notifier,
    async fetchIncomingFile() {
      downloads++;
      return null;
    },
  };
  const engine = engineFor(terminals, withFiles, 600_000);

  try {
    await engine.startTurn(pairing, "U1", "\r", {
      files: [{ id: "F1", name: "screen.png", size: 12 } as never],
    });
    assert.deepEqual(posts, [`${UNSENDABLE_TEXT_MESSAGE} 端末で確かめてください。`]);
    assert.equal(downloads, 0, "unsafe original text must be refused before attachment I/O");
    assert.deepEqual(submitted, []);
    assert.equal(engine.isBusy(target), false);
  } finally {
    engine.abortAll();
  }
});

test("OMP turns submit normal text and keep their poll loop attached", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cctag-omp-turn-submit-"));
  const target = `orca:${PANE}`;
  const pairing: Pairing = { ...fakePairing(), paneId: target, backend: "orca", cwd: dir };
  const sessionId = "9a51b84e-610c-4d9e-bb20-28d7c850c552";
  const transcriptIdentity = { path: join(dir, "omp.jsonl"), device: "1", inode: "2" };
  const submitted: string[] = [];
  const terminals = fakeBackend(
    () => "idle",
    () => "",
    {
      async get(receivedTarget) {
        return {
          ...fakeAgent("idle", "orca"),
          agent: "omp",
          ref: {
            target: receivedTarget,
            pid: 42,
            processStartedAt: 1,
            agentKind: "omp",
            sessionId,
            transcriptIdentity,
          },
          sessionId,
          transcriptIdentity,
        };
      },
      async submit(_ref, text) {
        submitted.push(text);
        return { status: "accepted", draftStashed: false };
      },
    },
    "orca",
  );
  const { notifier } = fakeNotifier();
  const engine = engineFor(terminals, notifier, 600_000);

  try {
    await engine.startTurn(pairing, "U1", "hello");
    assert.deepEqual(submitted, ["hello"]);
    assert.equal(engine.isBusy(target), true, "accepted OMP turns keep ownership while awaiting transcript/screen evidence");
  } finally {
    engine.abortAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an accepted OMP turn ignores historical completion until its own transcript boundary", { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cctag-omp-stale-end-"));
  const target = `orca:${PANE}`;
  const sessionId = "omp-stale-end";
  const transcriptPath = join(dir, "omp-session.jsonl");
  const transcriptIdentity = { path: transcriptPath, device: "1", inode: "2" };
  const pairing: Pairing = { ...fakePairing(), paneId: target, backend: "orca", cwd: dir };
  const historicalRecords = [
    {
      type: "message",
      timestamp: "2026-09-28T10:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "old prompt" }] },
    },
    {
      type: "message",
      timestamp: "2026-09-28T10:00:01.000Z",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "old OMP output" }],
      },
    },
  ];
  writeFileSync(transcriptPath, `${historicalRecords.map((record) => JSON.stringify(record)).join("\n")}\n`);

  let submitted = false;
  let pollCount = 0;
  let signalFirstPoll!: () => void;
  const firstPoll = new Promise<void>((resolve) => (signalFirstPoll = resolve));
  const terminals = fakeBackend(
    () => "working",
    () => "",
    {
      async get(receivedTarget) {
        if (submitted && pollCount++ === 0) signalFirstPoll();
        return {
          ...fakeAgent(submitted ? "working" : "idle"),
          ref: {
            target: receivedTarget,
            pid: 42,
            processStartedAt: 1,
            agentKind: "omp",
            sessionId,
            transcriptIdentity,
          },
          backend: "orca",
          agent: "omp",
          sessionId,
          cwd: dir,
          transcriptIdentity,
          evidence: { kind: "hint", state: "done", waitingSince: null },
        };
      },
      async read() {
        return { text: "", draft: null, complete: false };
      },
      async submit() {
        submitted = true;
        return { status: "accepted", draftStashed: false };
      },
    },
    "orca",
  );
  const { notifier, posts, updates } = fakeNotifier();
  const engine = new TurnEngine(
    terminals,
    notifier,
    { turnTimeoutMs: 600_000, pollIntervalMs: 100, limits: { maxFileBytes: 1024, maxFileCount: 1 } },
    { list: () => [pairing] },
  );

  try {
    await engine.startTurn(pairing, "U1", "new OMP prompt");
    await firstPoll;
    await sleep(20);
    assert.equal(engine.isBusy(target), true, "a historical completion must not finalize an accepted fresh turn");
    assert.equal(updates.some(({ text }) => text.startsWith("✅")), false);
    assert.equal(posts.some((post) => post.includes("old OMP output")), false);

    const newRecords = [
      {
        type: "message",
        timestamp: "2026-09-28T10:05:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "new prompt" }] },
      },
      {
        type: "message",
        timestamp: "2026-09-28T10:05:01.000Z",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "new OMP response" }],
        },
      },
    ];
    appendFileSync(transcriptPath, `${newRecords.map((record) => JSON.stringify(record)).join("\n")}\n`);
    for (let i = 0; i < 100; i++) {
      if (!engine.isBusy(target) && posts.join("\n").includes("new OMP response")) break;
      await sleep(20);
    }

    assert.equal(engine.isBusy(target), false, "a newly observed completion should release the turn");
    assert.ok(posts.some((post) => post.includes("new OMP response")), JSON.stringify(posts));
  } finally {
    engine.abortAll();
    rmSync(dir, { recursive: true, force: true });
  }
});


test("adopted OMP waits post one plain screen notice and resolve it at the terminal", async () => {
  const target = `orca:${PANE}`;
  const sessionId = "9a51b84e-610c-4d9e-bb20-28d7c850c552";
  const transcriptDir = mkdtempSync(join(tmpdir(), "cctag-omp-turn-wait-"));
  const transcriptPath = join(transcriptDir, "omp-session.jsonl");
  writeFileSync(transcriptPath, "");
  const transcriptIdentity = { path: transcriptPath, device: "1", inode: "2" };
  const agent: AgentInfo = {
    ...fakeAgent("working", "orca"),
    ref: {
      target,
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
  const waiting = capturedOmpScreen("ask-open.screen.json");
  const idle = capturedOmpScreen("idle.screen.json");
  const notice = formatOmpScreenNotice(waiting);
  const fingerprint = ompScreenFingerprint(waiting);
  assert.ok(notice);
  assert.ok(fingerprint);
  let screen = waiting;
  let failNextRead = false;
  let terminalWrites = 0;
  let screenReads = 0;
  let lastReadText = "";
  const terminals = fakeBackend(
    () => "working",
    () => "",
    {
      async get() {
        return agent;
      },
      async read() {
        screenReads++;
        if (failNextRead) {
          failNextRead = false;
          throw new Error("screen unavailable");
        }
        lastReadText = screen.text;
        return screen;
      },
      async submit() {
        terminalWrites++;
        return { status: "accepted", draftStashed: false };
      },
    },
    "orca",
  );
  const { notifier, posts, postedBlocks, updates } = fakeNotifier();
  const engine = engineFor(terminals, notifier, 600_000);
  const pairing: Pairing = { ...fakePairing(), paneId: target, backend: "orca" };

  try {
    assert.equal(
      await engine.adoptBlockedTerminal(pairing, {
        backend: "orca",
        driver: ompDriver,
        sessionId,
        transcriptIdentity,
        transcriptPath: transcriptIdentity.path,
        offset: 0,
        collected: [],
        paneId: target,
        ref: agent.ref,
        cwd: agent.cwd,
        outboxBaseline: {},
        writes: new WrittenFileTracker(),
        ompStatus: { waitingFingerprint: fingerprint, waitingSamples: 2, noticeFingerprint: null },
        ompNotice: notice,
        ompFingerprint: fingerprint,
      }),
      true,
    );
    assert.equal(engine.isOmpWaiting(target), true);
    assert.deepEqual(posts, ["🖥️ ターミナル側で入力待ちを検出しました…", notice]);
    assert.deepEqual(postedBlocks[1], [], "OMP notice has no answer buttons");
    failNextRead = true;
    await sleep(5_100);
    assert.equal(engine.isOmpWaiting(target), true, "an unreadable screen does not release the blocked wait");
    assert.equal(posts.filter((post) => post === notice).length, 1, "a failed screen read does not repost");
    assert.equal(terminalWrites, 0);

    screen = idle;
    for (let i = 0; i < 1_100 && engine.isOmpWaiting(target); i++) await sleep(10);
    assert.equal(lastReadText, idle.text, `poll must observe the complete idle screen (${screenReads} reads)`);
    assert.equal(engine.isOmpWaiting(target), false, "a complete idle composer releases the terminal-only wait");
    assert.ok(updates.some((update) => update.text === `${notice}\n\n（ターミナル側で回答済み）`));
  } finally {
    engine.abortAll();
    rmSync(transcriptDir, { recursive: true, force: true });
  }
});

test("OMP turn discards records and posts only the loss notice when ownership changes after a read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cctag-omp-turn-loss-"));
  let engine: TurnEngine | undefined;
  try {
    const cwd = join(dir, "cwd");
    mkdirSync(cwd);
    const transcriptPath = join(dir, "omp-session.jsonl");
    const sessionId = "9a51b84e-610c-4d9e-bb20-28d7c850c552";
    const transcriptIdentity = { path: transcriptPath, device: "1", inode: "2" };
    const record = {
      type: "message",
      timestamp: "2026-09-28T22:53:54.622Z",
      message: { role: "assistant", content: [{ type: "text", text: "must not be posted" }] },
    };
    writeFileSync(transcriptPath, `${JSON.stringify(record)}\n`);
    const target = `orca:${PANE}`;
    const pairing: Pairing = { ...fakePairing(), paneId: target, backend: "orca", cwd };
    const agent: AgentInfo = {
      ...fakeAgent("working", "orca"),
      agent: "omp",
      ref: {
        target,
        pid: 42,
        processStartedAt: 1,
        agentKind: "omp",
        sessionId,
        transcriptIdentity,
      },
      sessionId,
      transcriptIdentity,
      cwd,
      evidence: { kind: "hint", state: "working", waitingSince: null },
    };
    let gets = 0;
    const terminals = fakeBackend(
      () => "working",
      () => "",
      {
        async get() {
          gets++;
          return gets === 1 ? agent : null;
        },
        async exists() {
          return true;
        },
      },
      "orca",
    );
    const { notifier, posts } = fakeNotifier();
    engine = new TurnEngine(
      terminals,
      notifier,
      { turnTimeoutMs: 60_000, pollIntervalMs: 5, limits: { maxFileBytes: 1024, maxFileCount: 1 } },
      { list: () => [pairing] },
    );

    const adopted = await engine.adoptBlockedTerminal(pairing, {
      backend: "orca",
      driver: ompDriver,
      sessionId,
      transcriptPath,
      transcriptIdentity,
      offset: 0,
      collected: [],
      paneId: target,
      ref: agent.ref,
      cwd,
      outboxBaseline: {},
      writes: new WrittenFileTracker(),
    });
    assert.equal(adopted, true);
    for (let i = 0; i < 40 && engine.isBusy(target); i++) await sleep(10);

    assert.equal(engine.isBusy(target), false);
    assert.equal(posts.filter((post) => post === OMP_RESUME_NOTICE).length, 1);
    assert.equal(posts.some((post) => post.includes("must not be posted")), false);
  } finally {
    engine?.abortAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Orca permits interior LF and TAB and reports an accepted write", async () => {
  const target = `orca:${PANE}`;
  const pairing: Pairing = { ...fakePairing(), paneId: target, backend: "orca" };
  const text = "first line\n\tsecond line";
  const submitted: string[] = [];
  const terminals = fakeBackend(
    () => "idle",
    () => "",
    {
      async get(receivedTarget) {
        return {
          ...fakeAgent("idle", "orca"),
          ref: { target: receivedTarget, pid: 42, processStartedAt: 1 },
          sessionId: null,
        };
      },
      async submit(_ref, submittedText) {
        submitted.push(submittedText);
        return { status: "accepted", draftStashed: false };
      },
    },
    "orca",
  );
  const { notifier, updates } = fakeNotifier();
  const engine = engineFor(terminals, notifier, 600_000);

  try {
    await engine.startTurn(pairing, "U1", text);
    assert.deepEqual(submitted, [text], "interior LF/TAB must survive normalization");
    assert.ok(
      updates.some(({ text: update }) => update.includes("orca は入力を受け付けました")),
      "accepted writes need visible status feedback",
    );
  } finally {
    engine.abortAll();
  }
});

test("a startup dialog asks for a terminal-side answer instead of submitting", async () => {
  // Captured Claude Code fresh-directory prompt, shared with startup-prompt.test.ts.
  const startupDialog = [
    " Accessing workspace:",
    " /private/tmp/scratch/v3-workdir",
    " Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known",
    " open source project, or work from your team).",
    " ❯ 1. Yes, I trust this folder",
    "   2. No, exit",
    " Enter to confirm · Esc to cancel",
  ].join("\n");
  const target = `orca:${PANE}`;
  const pairing: Pairing = { ...fakePairing(), paneId: target, backend: "orca" };
  let submits = 0;
  const terminals = fakeBackend(
    () => "idle",
    () => startupDialog,
    {
      async get(receivedTarget) {
        return {
          ...fakeAgent("idle", "orca"),
          ref: { target: receivedTarget, pid: 42, processStartedAt: 1 },
          sessionId: null,
        };
      },
      async submit() {
        submits++;
        return { status: "accepted", draftStashed: false };
      },
    },
    "orca",
  );
  const { notifier, posts } = fakeNotifier();
  const engine = engineFor(terminals, notifier, 600_000);

  try {
    await engine.startTurn(pairing, "U1", "continue");
    assert.equal(submits, 0);
    assert.ok(posts.some((post) => post.includes("このダイアログは端末で答えてください")));
    assert.ok(posts.some((post) => post.includes("Is this a project you created or one you trust?")));
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
  const herdr = fakeBackend(() => "idle", () => "", {
    async submit(_ref, text) {
      prompted.push(text);
      return { status: "accepted", draftStashed: false };
    },
  });
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
  const terminals = fakeHerdr(() => "blocked");
  const engine = new TurnEngine(
    terminals,
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
  const terminals = fakeHerdr(() => "blocked");
  const engine = new TurnEngine(
    terminals,
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
  const herdr = fakeBackend(() => "working", () => "", {
    async submit() {
      await new Promise<void>((r) => (releasePrompt = r));
      return { status: "accepted", draftStashed: false };
    },
  });
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
  const herdr = fakeBackend(() => "blocked", () => PERMISSION_PANE, {
    async read() {
      reads += 1;
      if (reads <= 2) throw new Error("herdr command timed out");
      return { text: PERMISSION_PANE, draft: null, complete: true };
    },
  });
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

test("answering from Slack puts a status line where the answer was", async () => {
  // Reported from real use: pressing a button produced no visible sign of work,
  // because the status line belongs to the message the turn opened with — for an
  // adopted terminal, "入力待ちを検出しました", posted before the prompt and by then
  // well up the thread. The answer looked like it had gone nowhere, the next
  // message was sent, and it came back rejected as busy while the terminal was in
  // fact working.
  const { notifier, posts, postedBlocks } = fakeNotifier();
  const engine = engineFor(
    fakeHerdr(() => "blocked"),
    notifier,
    600_000,
  );

  try {
    await adopt(engine, fakePairing());
    await sleep(200);
    const before = posts.filter((p) => p.includes("実行中")).length;
    const promptId = promptIdFromPostedBlocks(postedBlocks);

    assert.deepEqual(
      await engine.answerPermissionButton(PANE, promptId, "1", fakePairing().key),
      { ok: true },
    );

    assert.equal(
      posts.filter((p) => p.includes("実行中")).length,
      before + 1,
      "a running status line must appear after the answer",
    );
  } finally {
    engine.abortAll();
  }
});

test("the new status line is the one the poll loop then updates", async () => {
  // Otherwise it would post "実行中…" once and then keep editing the old message up
  // the thread, which is the same invisibility in a new place.
  const events: string[] = [];
  const postedBlocks: unknown[][] = [];
  let status: AgentStatus = "blocked";
  const tracking: Notifier = {
    async postReply() {},
    async postMessage(_c, _t, text, blocks) {
      postedBlocks.push(blocks ?? []);
      const tag = text.slice(0, 6);
      events.push(`post[${tag}]`);
      return {
        async update(t: string) {
          events.push(`update[${tag}]=${t.slice(0, 6)}`);
        },
      };
    },
  };
  const engine = engineFor(fakeHerdr(() => status), tracking, 600_000);

  try {
    await adopt(engine, fakePairing());
    await sleep(200);
    const promptId = promptIdFromPostedBlocks(postedBlocks);
    assert.deepEqual(
      await engine.answerPermissionButton(PANE, promptId, "1", fakePairing().key),
      { ok: true },
    );
    status = "working"; // the agent picks the work up
    events.length = 0;
    // Past the five-second floor the loop is waiting out: an answer deliberately
    // does not cut that short, because resuming inside the moment the pane still
    // reports `blocked` re-posted the prompt just answered.
    await sleep(5_600);

    const refreshed = events.filter((e) => e.startsWith("update[⚙️ 実行中]"));
    assert.ok(refreshed.length > 0, `the new line must be the one refreshed, got ${JSON.stringify(events)}`);
    assert.ok(
      !events.some((e) => e.startsWith("update[🖥️ ターミ")),
      "and the message the turn opened with is left alone",
    );
  } finally {
    engine.abortAll();
  }
});

test("an answer records who pressed it when that was not the owner", async () => {
  // Nothing in the thread said who had acted on it. Slack guarantees the actor on
  // a button payload — unlike anything typed into a message — so it is worth
  // recording; the owner's own answers stay unmarked, which keeps a thread only
  // they use looking exactly as it did.
  const { notifier, postedBlocks } = fakeNotifier();
  const updates: string[] = [];
  const recording: Notifier = {
    ...notifier,
    async postMessage(_c, _t, text, blocks) {
      postedBlocks.push(blocks ?? []);
      return {
        async update(t: string) {
          if (text.includes("許可")) updates.push(t);
        },
      };
    },
  };
  const engine = engineFor(fakeHerdr(() => "blocked"), recording, 600_000);

  try {
    await adopt(engine, fakePairing());
    await sleep(200);
    const promptId = promptIdFromPostedBlocks(postedBlocks);
    assert.deepEqual(
      await engine.answerPermissionButton(PANE, promptId, "1", fakePairing().key, "佐藤"),
      { ok: true },
    );
    assert.ok(
      updates.some((u) => u.includes("佐藤")),
      `the actor must be recorded, got ${JSON.stringify(updates)}`,
    );
  } finally {
    engine.abortAll();
  }
});
test("the owner's own answer is left unmarked", async () => {
  const { notifier, postedBlocks } = fakeNotifier();
  const updates: string[] = [];
  const recording: Notifier = {
    ...notifier,
    async postMessage(_c, _t, text, blocks) {
      postedBlocks.push(blocks ?? []);
      return {
        async update(t: string) {
          if (text.includes("許可")) updates.push(t);
        },
      };
    },
  };
  const engine = engineFor(fakeHerdr(() => "blocked"), recording, 600_000);

  try {
    await adopt(engine, fakePairing());
    await sleep(200);
    const promptId = promptIdFromPostedBlocks(postedBlocks);
    await engine.answerPermissionButton(PANE, promptId, "1", fakePairing().key); // no actor — the owner
    assert.deepEqual(updates, ["→ 1 を送信しました"], "unmarked means the owner, as it always has");
  } finally {
    engine.abortAll();
  }
});

// --- uploadAttachments: logs, since it says nothing else on success -----------
// Production incident (2026-08-28): a student's session sent dozens of files
// via SendUserFile in a loop the agent drove itself (Claude Code's own
// ScheduleWakeup, not a Slack-triggered turn). The text progress reports
// reached Slack every time; not one file did, and nothing distinguished that
// from success — uploadAttachments has never logged on its own. These pin the
// three points that now do.

/** Captures console.log/console.error for one call, then restores them. */
async function captureConsole(run: () => Promise<void>): Promise<{ logs: string[]; errors: string[] }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
  try {
    await run();
  } finally {
    console.log = origLog;
    console.error = origError;
  }
  return { logs, errors };
}

const NO_ATTACHMENTS_CWD = "/tmp/nonexistent-cctag-test"; // no .cctag/outbox here — snapshotOutbox tolerates that

test("a confirmed SendUserFile with no uploadFile support logs, since it has nowhere to go", async () => {
  const { notifier } = fakeNotifier(); // no uploadFile on this stub
  const engine = engineFor(fakeHerdr(() => "idle"), notifier, 600_000);

  const { errors } = await captureConsole(() =>
    engine.uploadOutboxAdditions(fakePairing(), NO_ATTACHMENTS_CWD, {}, [{ path: "report.pdf" }]).then(() => {}),
  );

  assert.ok(
    errors.some((e) => e.includes("1 confirmed SendUserFile") && e.includes("no uploadFile")),
    `expected a no-uploadFile error, got: ${JSON.stringify(errors)}`,
  );
});

test("nothing to attach logs nothing", async () => {
  // The common case, every settle event without exception on most panes — must
  // stay silent, or the log this incident needs becomes noise nobody reads.
  const { notifier } = fakeNotifier();
  const withUpload: Notifier = { ...notifier, async uploadFile() {} };
  const engine = engineFor(fakeHerdr(() => "idle"), withUpload, 600_000);

  const { logs, errors } = await captureConsole(() =>
    engine.uploadOutboxAdditions(fakePairing(), NO_ATTACHMENTS_CWD, {}, []).then(() => {}),
  );

  assert.deepEqual(logs, []);
  assert.deepEqual(errors, []);
});

test("a confirmed SendUserFile that does upload logs the candidate count and the outcome", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cctag-upload-"));
  try {
    const filePath = join(dir, "report.pdf");
    writeFileSync(filePath, "not actually a pdf, just needs to be a real file");

    const uploads: string[] = [];
    const { notifier } = fakeNotifier();
    const withUpload: Notifier = {
      ...notifier,
      async uploadFile(_c, _t, args) {
        uploads.push(args.filename);
      },
    };
    const engine = engineFor(fakeHerdr(() => "idle"), withUpload, 600_000);

    const { logs } = await captureConsole(() =>
      engine.uploadOutboxAdditions(fakePairing(), dir, {}, [{ path: filePath }]).then(() => {}),
    );

    assert.deepEqual(uploads, ["report.pdf"], "the upload itself must still happen");
    assert.ok(
      logs.some((l) => l.includes("1 candidate") && l.includes("1 to upload")),
      `expected the candidate-count line, got: ${JSON.stringify(logs)}`,
    );
    assert.ok(
      logs.some((l) => l.includes("1/1 uploaded")),
      `expected the outcome line, got: ${JSON.stringify(logs)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an incomplete list from either backend prevents automatic outbox uploads", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cctag-incomplete-outbox-"));
  try {
    const outbox = join(cwd, ".cctag", "outbox");
    mkdirSync(outbox, { recursive: true });
    const candidate = join(outbox, "artifact.txt");
    writeFileSync(candidate, "keep this file on disk");

    const uploads: string[] = [];
    const { notifier, posts } = fakeNotifier();
    const withUpload: Notifier = {
      ...notifier,
      async uploadFile(_channel, _threadTs, args) {
        uploads.push(args.filename);
      },
    };
    for (const failedBackend of ["orca", "herdr"] as const) {
      const pairing: Pairing =
        failedBackend === "orca"
          ? { ...fakePairing(), paneId: `orca:${PANE}`, backend: "orca" }
          : fakePairing();
      const terminals = fakeBackend(
        () => "idle",
        () => "",
        {
          async list() {
            return {
              agents: [],
              failures: [{ backend: failedBackend, reason: "backend unavailable" }],
              complete: false,
              notices: [],
            };
          },
        },
      );
      const engine = engineFor(terminals, withUpload, 600_000);
      await engine.uploadOutboxAdditions(pairing, cwd, {}, []);
    }

    assert.deepEqual(uploads, []);
    assert.equal(posts.filter((post) => post.includes("自動添付を見送りました")).length, 2);
    assert.ok(posts.some((post) => post.includes("orcaのインスタンス一覧")));
    assert.ok(posts.some((post) => post.includes("herdrのインスタンス一覧")));
    assert.equal(readFileSync(candidate, "utf8"), "keep this file on disk");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// --- multi-select questions -------------------------------------------------

/** A multi-select dialog as Claude Code 2.1.251 draws it (checkbox on every
 *  row, the free-text one included) — the shape captured in prompts.test.ts. */
function multiSelectPane(question: string): string {
  return [
    "←  ☐ 削る場所  ✔ Submit  →",
    "",
    `│ ${question}`,
    "",
    "❯ 1. [ ] §2.1「橋渡し」を圧縮",
    "  現在10行。新設する段落と重複するので圧縮する。",
    "  2. [ ] §6.2「モデルの大きさ」を圧縮",
    "  現在14行。査読者の反論への防御なので薄くなる。",
    "  3. [ ] §5.3の処理時間の記述を圧縮",
    "  現在11行。内訳を簡略化して3行捻出。",
    "  4. [ ] Type something",
    "     Submit",
    "─".repeat(60),
    "  5. Chat about this",
  ].join("\n");
}

/** Like fakeNotifier, but keeps what each posted message was later updated to
 *  — which is where the terminal-answered replacement lands. */
function recordingNotifier(): {
  notifier: Notifier;
  posts: string[];
  updates: string[];
  postedBlocks: unknown[][];
} {
  const posts: string[] = [];
  const updates: string[] = [];
  const postedBlocks: unknown[][] = [];
  const handle: MessageHandle = {
    async update(text) {
      updates.push(text);
    },
  };
  const notifier: Notifier = {
    async postReply(_c, _t, text) {
      posts.push(text);
    },
    async postMessage(_c, _t, text, blocks) {
      posts.push(text);
      postedBlocks.push(blocks ?? []);
      return handle;
    },
  };
  return { notifier, posts, updates, postedBlocks };
}

const MULTI_SELECT_REVIEW = [
  "←  ☒ 削る場所  ✔ Submit  →",
  "",
  "Review your answers",
  "",
  "Ready to submit your answers?",
  "",
  "❯ 1. Submit answers",
].join("\n");

interface FakeHerdrAnswerCli {
  bin: string;
  calls(): string[][];
  pane(): string;
  setPane(text: string): void;
  cleanup(): void;
}

function fakeHerdrAnswerCli(
  initialPane: string,
  reviewPane = MULTI_SELECT_REVIEW,
  failReviewDigit = false,
): FakeHerdrAnswerCli {
  const dir = mkdtempSync(join(tmpdir(), "cctag-turn-herdr-"));
  const bin = join(dir, "herdr-test");
  const callsFile = join(dir, "calls.jsonl");
  const paneFile = join(dir, "pane.txt");
  const script = `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(args) + "\\n");
if (args[0] === "pane" && args[1] === "send-keys" && args.includes("Enter")) {
  fs.writeFileSync(${JSON.stringify(paneFile)}, ${JSON.stringify(reviewPane)});
}
if (
  ${JSON.stringify(failReviewDigit)} &&
  args[0] === "pane" &&
  args[1] === "send-text" &&
  args[3] === "1" &&
  fs.readFileSync(${JSON.stringify(paneFile)}, "utf8").includes("Review your answers")
) {
  process.exit(1);
}
if (args[0] === "pane" && args[1] === "read") {
  process.stdout.write(fs.readFileSync(${JSON.stringify(paneFile)}, "utf8"));
}
`;
  writeFileSync(bin, script);
  writeFileSync(paneFile, initialPane);
  chmodSync(bin, 0o755);
  return {
    bin,
    calls() {
      try {
        const text = readFileSync(callsFile, "utf8").trim();
        return text ? text.split("\n").map((line) => JSON.parse(line) as string[]) : [];
      } catch {
        return [];
      }
    },
    pane() {
      return readFileSync(paneFile, "utf8");
    },
    setPane(text) {
      writeFileSync(paneFile, text);
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function multiSelectHerdr(
  pane: () => string,
  reviewPane = MULTI_SELECT_REVIEW,
  failReviewDigit = false,
): { herdr: FakeBackend; cli: FakeHerdrAnswerCli } {
  const cli = fakeHerdrAnswerCli(pane(), reviewPane, failReviewDigit);
  const backend = new HerdrBackend(cli.bin);
  const herdr = fakeBackend(() => "blocked", () => cli.pane(), {
    openAnswer(ref, prompt) {
      return backend.openAnswer(ref, prompt);
    },
  });
  return { herdr, cli };
}


/**
 * Adopts the pane and waits for the prompt to be posted.
 *
 * adoptBlockedTerminal hands the pane to the poll loop and returns before that
 * loop's first pass, so the phase is still `running` and there is no pending
 * question to answer for a moment after it resolves.
 */
async function adoptAndAwaitPrompt(engine: TurnEngine, pairing: Pairing = fakePairing()): Promise<void> {
  await adopt(engine, pairing);
  await sleep(60);
}

/** While a prompt is up the loop sleeps on a 5s floor (turn.ts), so noticing
 *  that a *different* prompt replaced it cannot be observed sooner. */
const BLOCKED_POLL_FLOOR_MS = 5_600;

test("a multi-select answer confirms a review without requiring a Cancel row", async () => {
  // Until 2026-08-31 it could not: the blocks carried no interactive element, so
  // the only way to answer was at the keyboard. Reported from a four-question
  // dialog where question 1 was answered from Slack and question 2 — the
  // multi-select one — was not.
  const { notifier, updates, postedBlocks } = recordingNotifier();
  const { herdr, cli } = multiSelectHerdr(() => multiSelectPane("どこから捻出しますか？"));
  const engine = engineFor(herdr, notifier, 600_000);
  try {
    await adoptAndAwaitPrompt(engine);
    const promptId = promptIdFromPostedBlocks(postedBlocks);
    const result = await engine.answerQuestionMultiSelect(PANE, promptId, [0, 2], fakePairing().key);
    assert.equal(result.ok, true);
    assert.deepEqual(cli.calls(), [
      ["pane", "read", PANE, "--source", "recent", "--lines", "200"],
      ["pane", "send-text", PANE, "1"],
      ["pane", "send-text", PANE, "3"],
      ["pane", "send-keys", PANE, "Down", "Down", "Down", "Down"],
      ["pane", "send-keys", PANE, "Enter"],
      ["pane", "send-text", PANE, "1"],
    ]);
    assert.ok(
      updates.some((u) => u.includes("§2.1「橋渡し」を圧縮") && u.includes("§5.3の処理時間の記述を圧縮")),
      "the thread should say which options were chosen",
    );
  } finally {
    engine.abortAll();
    cli.cleanup();
  }
});

test("a non-review transition ends the compound answer on Submit Enter", async () => {
  const { notifier, updates, postedBlocks } = recordingNotifier();
  const nextQuestion = multiSelectPane("次の設問です");
  const { herdr, cli } = multiSelectHerdr(() => multiSelectPane("どこから捻出しますか？"), nextQuestion);
  const engine = engineFor(herdr, notifier, 600_000);
  try {
    await adoptAndAwaitPrompt(engine);
    const promptId = promptIdFromPostedBlocks(postedBlocks);
    assert.equal((await engine.answerQuestionMultiSelect(PANE, promptId, [0], fakePairing().key)).ok, true);
    assert.deepEqual(cli.calls(), [
      ["pane", "read", PANE, "--source", "recent", "--lines", "200"],
      ["pane", "send-text", PANE, "1"],
      ["pane", "send-keys", PANE, "Down", "Down", "Down", "Down"],
      ["pane", "send-keys", PANE, "Enter"],
    ]);
    assert.ok(updates.some((update) => update.includes("§2.1「橋渡し」を圧縮")));
  } finally {
    engine.abortAll();
    cli.cleanup();
  }
});


test("a changed multi-select prompt gets no writes before the first Herdr check", async () => {
  const { notifier, postedBlocks, updates } = recordingNotifier();
  const { herdr, cli } = multiSelectHerdr(() => multiSelectPane("どこから捻出しますか？"));
  const engine = engineFor(herdr, notifier, 600_000);
  try {
    await adoptAndAwaitPrompt(engine);
    const promptId = promptIdFromPostedBlocks(postedBlocks);
    cli.setPane(multiSelectPane("別の質問に変わりました"));
    await assert.rejects(
      engine.answerQuestionMultiSelect(PANE, promptId, [0], fakePairing().key),
      ExpectationLost,
    );
    assert.equal(
      updates.some((update) => update.includes("（ターミナル側で回答済み）")),
      false,
      "an incomplete answer must not resolve the Slack prompt",
    );
  } finally {
    engine.abortAll();
    cli.cleanup();
  }
});

test("a failed review confirmation leaves the Slack prompt unresolved", async () => {
  const { notifier, postedBlocks, updates } = recordingNotifier();
  const { herdr, cli } = multiSelectHerdr(
    () => multiSelectPane("どこから捻出しますか？"),
    MULTI_SELECT_REVIEW,
    true,
  );
  const engine = engineFor(herdr, notifier, 600_000);
  try {
    await adoptAndAwaitPrompt(engine);
    const promptId = promptIdFromPostedBlocks(postedBlocks);
    await assert.rejects(engine.answerQuestionMultiSelect(PANE, promptId, [0], fakePairing().key));
    assert.deepEqual(cli.calls(), [
      ["pane", "read", PANE, "--source", "recent", "--lines", "200"],
      ["pane", "send-text", PANE, "1"],
      ["pane", "send-keys", PANE, "Down", "Down", "Down", "Down"],
      ["pane", "send-keys", PANE, "Enter"],
      ["pane", "send-text", PANE, "1"],
    ]);
    assert.equal(
      updates.some((update) => update.includes("（ターミナル側で回答済み）")),
      false,
      "a failed final write must not resolve the Slack prompt",
    );
  } finally {
    engine.abortAll();
    cli.cleanup();
  }
});

test("a stale submit for an already-answered question is refused", async () => {
  const { notifier, postedBlocks } = recordingNotifier();
  const { herdr, cli } = multiSelectHerdr(() => multiSelectPane("どこから捻出しますか？"));
  const engine = engineFor(herdr, notifier, 600_000);
  try {
    await adoptAndAwaitPrompt(engine);
    const promptId = promptIdFromPostedBlocks(postedBlocks);
    const pairingKey = fakePairing().key;
    assert.equal((await engine.answerQuestionMultiSelect(PANE, promptId, [0], pairingKey)).ok, true);
    const again = await engine.answerQuestionMultiSelect(PANE, promptId, [1], pairingKey);
    assert.equal(again.ok, false, "the prompt id is spent");
  } finally {
    engine.abortAll();
    cli.cleanup();
  }
});

test("indices outside the option list never reach the pane as keystrokes", async () => {
  const { notifier, postedBlocks } = recordingNotifier();
  const { herdr, cli } = multiSelectHerdr(() => multiSelectPane("どこから捻出しますか？"));
  const engine = engineFor(herdr, notifier, 600_000);
  try {
    await adoptAndAwaitPrompt(engine);
    const promptId = promptIdFromPostedBlocks(postedBlocks);
    // 10 would be typed into the dialog as a keystroke meaning nothing — or, on
    // a dialog with ten rows, as the wrong one.
    await engine.answerQuestionMultiSelect(PANE, promptId, [0, 9], fakePairing().key);
    const textWrites = cli.calls().filter((args) => args[1] === "send-text").map((args) => args[3]);
    assert.deepEqual(textWrites, ["1", "1"], "valid choice and review confirm only");
  } finally {
    engine.abortAll();
    cli.cleanup();
  }
});

test("answering at the keyboard keeps the question in the thread", async () => {
  // The message used to be replaced by the bare note, so a thread recorded that
  // *something* had been asked and answered with no way to see what. Observed on
  // the same four-question dialog: one line of evidence, and it named neither
  // the question nor its options.
  const { notifier, updates } = recordingNotifier();
  let question = "どこから捻出しますか？";
  const { herdr, cli } = multiSelectHerdr(() => multiSelectPane(question));
  const engine = engineFor(herdr, notifier, 600_000);
  try {
    await adoptAndAwaitPrompt(engine);
    // A *different* question now showing, with the pane never leaving `blocked`,
    // is how the poll loop learns the pending one was answered at the terminal.
    question = "見直し範囲はどうしますか？";
    cli.setPane(multiSelectPane(question));
    await sleep(BLOCKED_POLL_FLOOR_MS);

    const note = updates.find((u) => u.includes("（ターミナル側で回答済み）"));
    assert.ok(note, "the prompt should be marked answered");
    assert.ok(note.includes("どこから捻出しますか？"), "the question must survive the update");
    assert.ok(note.includes("§2.1「橋渡し」を圧縮"), "so must the options");
  } finally {
    engine.abortAll();
    cli.cleanup();
  }
});

test("a reply of just option numbers ticks those boxes instead of being typed as text", async () => {
  // What a reader actually types, reported from real use. Claude Code does not
  // read "1,3" as a selection — the free-text row records it verbatim — so
  // without this the agent received the string "1,3" and had to guess.
  const { notifier, updates } = recordingNotifier();
  const { herdr, cli } = multiSelectHerdr(() => multiSelectPane("どこから捻出しますか？"));
  const engine = engineFor(herdr, notifier, 600_000);
  try {
    await adoptAndAwaitPrompt(engine);
    assert.equal((await engine.answerQuestionFreeText(PANE, "1,3")).ok, true);
    assert.deepEqual(cli.calls(), [
      ["pane", "read", PANE, "--source", "recent", "--lines", "200"],
      ["pane", "send-text", PANE, "1"],
      ["pane", "send-text", PANE, "3"],
      ["pane", "send-keys", PANE, "Down", "Down", "Down", "Down"],
      ["pane", "send-keys", PANE, "Enter"],
      ["pane", "send-text", PANE, "1"],
    ]);
    assert.ok(
      updates.some((u) => u.includes("§2.1「橋渡し」を圧縮") && u.includes("§5.3の処理時間の記述を圧縮")),
      "the thread should name the options, not echo the digits",
    );
  } finally {
    engine.abortAll();
    cli.cleanup();
  }
});

test("a reply that is not just option numbers is still passed through as text", async () => {
  const { notifier } = recordingNotifier();
  const { herdr, cli } = multiSelectHerdr(() => multiSelectPane("どこから捻出しますか？"));
  const engine = engineFor(herdr, notifier, 600_000);
  try {
    await adoptAndAwaitPrompt(engine);
    // Out of range, so it cannot be a selection — and a duplicate would toggle
    // the same box off again, which is worse than passing the text along.
    assert.equal((await engine.answerQuestionFreeText(PANE, "1,9")).ok, true);
    assert.deepEqual(cli.calls(), [
      ["pane", "read", PANE, "--source", "recent", "--lines", "200"],
      ["pane", "send-keys", PANE, "Down", "Down", "Down"],
      ["pane", "send-text", PANE, "1,9"],
      ["pane", "send-keys", PANE, "Down"],
      ["pane", "send-keys", PANE, "Enter"],
      ["pane", "send-text", PANE, "1"],
    ]);
  } finally {
    engine.abortAll();
    cli.cleanup();
  }
});

test("prompt IDs stay safe and distinct across turns", async () => {
  const ids = new Set<number>();
  for (let i = 0; i < 12; i++) {
    const { notifier, postedBlocks } = fakeNotifier();
    const engine = engineFor(fakeHerdr(() => "blocked"), notifier, 600_000);
    try {
      await adoptAndAwaitPrompt(engine);
      const promptId = promptIdFromPostedBlocks(postedBlocks);
      assert.ok(Number.isSafeInteger(promptId) && promptId > 0, `unsafe prompt ID: ${promptId}`);
      assert.equal(ids.has(promptId), false, `prompt ID was reused: ${promptId}`);
      ids.add(promptId);
    } finally {
      engine.abortAll();
      for (let attempt = 0; attempt < 40 && engine.isBusy(PANE); attempt++) await sleep(25);
      assert.equal(engine.isBusy(PANE), false, "the poll loop must release before the next turn");
    }
  }
});

test("a button from the previous turn cannot answer the next same-kind prompt", async () => {
  const pairing = fakePairing();
  const oldButton = fakeNotifier();
  const previousTurn = engineFor(fakeHerdr(() => "blocked"), oldButton.notifier, 600_000);
  try {
    await adoptAndAwaitPrompt(previousTurn, pairing);
  } finally {
    previousTurn.abortAll();
    for (let attempt = 0; attempt < 40 && previousTurn.isBusy(PANE); attempt++) await sleep(25);
    assert.equal(previousTurn.isBusy(PANE), false);
  }
  const previousPromptId = promptIdFromPostedBlocks(oldButton.postedBlocks);

  const nextButton = fakeNotifier();
  const writes: string[] = [];
  const herdr = fakeBackend(() => "blocked", () => PERMISSION_PANE, {
    openAnswer() {
      return fakeAnswerChannel({
        async digit(n) {
          writes.push(`text:${n}`);
        },
        async confirm() {
          writes.push("key:Enter");
        },
      });
    },
  });
  const currentTurn = engineFor(herdr, nextButton.notifier, 600_000);
  try {
    await adoptAndAwaitPrompt(currentTurn, pairing);
    const currentPromptId = promptIdFromPostedBlocks(nextButton.postedBlocks);
    assert.notEqual(currentPromptId, previousPromptId);
    assert.deepEqual(
      await currentTurn.answerPermissionButton(PANE, previousPromptId, "1", pairing.key),
      { ok: false, reason: "not-pending" },
    );
    assert.deepEqual(writes, [], "the stale button must not write to the pane");
  } finally {
    currentTurn.abortAll();
  }
});

test("a matching prompt ID from another pairing is rejected without writing keys", async () => {
  const { notifier, postedBlocks } = fakeNotifier();
  const writes: string[] = [];
  const herdr = fakeBackend(() => "blocked", () => PERMISSION_PANE, {
    openAnswer() {
      return fakeAnswerChannel({
        async digit(n) {
          writes.push(`text:${n}`);
        },
        async confirm() {
          writes.push("key:Enter");
        },
      });
    },
  });
  const engine = engineFor(herdr, notifier, 600_000);
  try {
    await adoptAndAwaitPrompt(engine);
    const promptId = promptIdFromPostedBlocks(postedBlocks);
    assert.deepEqual(
      await engine.answerPermissionButton(PANE, promptId, "1", "C1:another-thread"),
      { ok: false, reason: "not-pending" },
    );
    assert.deepEqual(writes, [], "a button from another thread must not write to the pane");
  } finally {
    engine.abortAll();
  }
});

test("a channel pairing accepts its own permission button", async () => {
  const pairing: Pairing = { ...fakePairing(), key: "C1", threadTs: undefined };
  const { notifier, postedBlocks } = fakeNotifier();
  const engine = engineFor(fakeHerdr(() => "blocked"), notifier, 600_000);
  try {
    await adoptAndAwaitPrompt(engine, pairing);
    const promptId = promptIdFromPostedBlocks(postedBlocks);
    assert.deepEqual(
      await engine.answerPermissionButton(PANE, promptId, "1", pairing.key),
      { ok: true },
    );
  } finally {
    engine.abortAll();
  }
});
