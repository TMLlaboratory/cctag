import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WrittenFileTracker } from "../attachments.js";
import type { Notifier } from "../notifier.js";
import type { Pairing } from "../pairing.js";
import { TurnEngine } from "../turn.js";
import { claudeDriver } from "../agents/claude/driver.js";
import { codexDriver, parseCodexModelMenuPrompt } from "../agents/codex/driver.js";
import { agentPickerBlocks } from "../slack/blocks.js";
import { stripSidePane } from "./side-pane.js";
import { HcBackend, HC_TYPED_TEXT_UNSUPPORTED, HC_UNSUPPORTED_AGENTS_NOTICE } from "./herdr-core.js";
import type { SubmitContext } from "./index.js";
import type { VerifiedPrompt } from "./prompt.js";
import { BackendUnavailable, ExpectationLost, SubmitRefused, WriteOutcomeUnknown, type AgentRef } from "./types.js";

const FIXTURES = new URL("../agents/claude/__fixtures__/", import.meta.url);
const QUESTION_SCREEN = JSON.parse(readFileSync(new URL("hc-question.screen.json", FIXTURES), "utf8")) as { text: string };
const PLAN_SCREEN = JSON.parse(readFileSync(new URL("hc-plan-approval.screen.json", FIXTURES), "utf8")) as { text: string };
const STARTUP_SCREEN = readFileSync(new URL("startup-trust.screen.txt", FIXTURES), "utf8");
const CLAUDE_COMPOSER = JSON.parse(readFileSync(new URL("idle-composer.screen.json", FIXTURES), "utf8")).terminal.tail.join("\n");
const CODEX_COMPOSER = JSON.parse(readFileSync(new URL("../agents/codex/__fixtures__/hc-idle-fresh.screen.json", import.meta.url), "utf8")).text;
const CODEX_QUESTION = JSON.parse(readFileSync(new URL("../agents/codex/__fixtures__/hc-question.screen.json", import.meta.url), "utf8")).text;
const CODEX_TRUST = JSON.parse(readFileSync(new URL("../agents/codex/__fixtures__/hc-trust.screen.json", import.meta.url), "utf8")).text;
const MODEL_SCREEN = JSON.parse(readFileSync(new URL("../agents/codex/__fixtures__/hc-model.screen.json", import.meta.url), "utf8")).text;

interface FakeTerminal {
  address: string;
  agent?: string;
  state?: string;
  status?: string | null;
  kind?: string;
  pid?: number;
  foregroundName?: string;
  foregroundCwd?: string | null;
  name?: string | null;
  turn?: number;
  title?: string;
}

interface Fake {
  bin: string;
  socket: string;
  sessionsDir: string;
  calls(): { args: string[]; env: Record<string, string | undefined> }[];
  setTerminal(terminal: Partial<FakeTerminal>): void;
  startCore(): Promise<void>;
  cleanup(): Promise<void>;
}

interface FakeOptions {
  screens?: string[];
  incomplete?: boolean;
  readError?: boolean;
  terminalAfterRead?: Partial<FakeTerminal>;
  send?: Record<string, unknown> | { error: { kind: string; message: string } };
}

/**
 * A stand-in for `hc` that answers from a JSON table, errors the way hc does
 * (a JSON error on stderr and a non-zero exit), and records every call with
 * the HC_* variables it saw.
 */
function fakeHc(
  terminals: FakeTerminal[],
  options: FakeOptions = {},
): Fake {
  const dir = mkdtempSync(join(tmpdir(), "cctag-hc-"));
  const bin = join(dir, "hc");
  const callsFile = join(dir, "calls.jsonl");
  const readCount = join(dir, "read-count");
  const terminalOverride = join(dir, "terminal-override.json");
  const sessionsDir = join(dir, "sessions");
  mkdirSync(sessionsDir);
  for (const t of terminals) {
    if (t.pid !== undefined) {
      writeFileSync(join(sessionsDir, `${t.pid}.json`), JSON.stringify({ pid: t.pid, sessionId: `session-${t.pid}`, cwd: `/repo/${t.address}` }));
    }
  }
  const script = `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const ops = args.includes("--") ? args.slice(args.indexOf("--") + 1) : [];
const env = { HC_TERMINAL_ID: process.env.HC_TERMINAL_ID, HC_SCOPE: process.env.HC_SCOPE, HC_TERMINAL_SOCKET: process.env.HC_TERMINAL_SOCKET, HC_SOCKET: process.env.HC_SOCKET };
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ args, env }) + "\\n");
const terminals = ${JSON.stringify(terminals)};
const screens = ${JSON.stringify(options.screens ?? ["screen text"])};
const send = ${JSON.stringify(options.send ?? { started: true, status: "working", turn: 2 })};
const afterRead = ${JSON.stringify(options.terminalAfterRead ?? {})};
const fail = (kind, message, code) => { process.stderr.write(JSON.stringify({ error: { kind, message } })); process.exit(code); };
const find = (address) => terminals.find((t) => t.address === address) ?? fail("not_found", "no terminal " + address, 3);
const out = (value) => process.stdout.write(JSON.stringify(value));
if (args[0] === "ls") {
  out({ terminals: terminals.map((t) => ({ address: t.address, agent: t.agent, state: t.state ?? "live", ...(t.status === undefined ? {} : { status: t.status }) })) });
} else if (args[0] === "get") {
  const file = ${JSON.stringify(terminalOverride)};
  const t = { ...find(ops[0]), ...(fs.existsSync(${JSON.stringify(readCount)}) ? afterRead : {}),
    ...(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {}) };
  out({
    address: t.address, name: t.name ?? null, cwd: "/created/here", state: t.state ?? "live", title: t.title ?? "",
    foreground: t.pid === undefined ? null : { pid: t.pid, cwd: t.foregroundCwd === undefined ? "/moved/here" : t.foregroundCwd, name: t.foregroundName ?? "claude" },
    status: t.status == null ? null : { app: t.agent, state: t.status, kind: t.kind },
    turn: t.turn,
  });
} else if (args[0] === "read") {
  find(ops[0]);
  if (${JSON.stringify(options.readError ?? false)}) fail("unavailable", "screen unavailable", 5);
  const n = Number(fs.existsSync(${JSON.stringify(readCount)}) ? fs.readFileSync(${JSON.stringify(readCount)}, "utf8") : "0");
  fs.writeFileSync(${JSON.stringify(readCount)}, String(n + 1));
  out({ text: screens[Math.min(n, screens.length - 1)], complete: ${!options.incomplete}, how: "screen" });
} else if (args[0] === "send") {
  if (send.error) fail(send.error.kind, send.error.message, 9);
  out(send);
} else if (args[0] === "keys") {
  find(ops[0]);
  out({ ok: true });
} else {
  fail("usage", "unexpected " + args.join(" "), 2);
}
`;
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  const socket = join(dir, "core.sock");
  let server: Server | null = null;
  return {
    bin,
    socket,
    sessionsDir,
    setTerminal: (terminal) => writeFileSync(terminalOverride, JSON.stringify(terminal)),
    calls: () =>
      existsSync(callsFile)
        ? readFileSync(callsFile, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [],
    startCore: () =>
      new Promise((resolve) => {
        server = createServer((socket) => socket.destroy());
        server.listen(socket, () => resolve());
      }),
    cleanup: async () => {
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function withCore(terminals: FakeTerminal[], options: Parameters<typeof fakeHc>[1], run: (backend: HcBackend, fake: Fake) => Promise<void>) {
  const fake = fakeHc(terminals, options);
  try {
    await fake.startCore();
    await run(new HcBackend(fake.bin, { socket: fake.socket, sessionsDir: fake.sessionsDir }), fake);
  } finally {
    await fake.cleanup();
  }
}

const CTX: SubmitContext = {
  driver: claudeDriver,
  cancelled: () => false,
  transcriptGrew: () => null,
  retryLimit: 1,
  pollIntervalMs: 1,
};
const CLAUDE: FakeTerminal = { address: "t1", agent: "claude-code", status: "blocked", pid: 101 };
const PAIRING: Pairing = {
  key: "C1:1.1", channel: "C1", threadTs: "1.1", paneId: "hc:t1", pairedBy: "U1", pairedAt: "2026-11-22T00:00:00Z",
  terminalId: "t1", cwd: "/repo/t1", backend: "herdr-core",
};

function ref(address: string): AgentRef {
  return { target: `hc:${address}`, pid: null, processStartedAt: null };
}

function verified(screen: string): VerifiedPrompt {
  const parsed = claudeDriver.parseBlockedPane(screen);
  if (parsed.kind !== "question" && parsed.kind !== "permission") throw new Error(`expected a prompt, got ${parsed.kind}`);
  return parsed.verified;
}

function testEngine(backend: HcBackend, notifier: Notifier): TurnEngine {
  return new TurnEngine(backend, notifier, {
    turnTimeoutMs: 60_000, pollIntervalMs: 5, limits: { maxFileBytes: 1024, maxFileCount: 1 },
  }, { list: () => [PAIRING] });
}

test("an adopted hc turn reads after a status update and never publishes the replacement foreground", async (t) => {
  for (const scenario of [
    { name: "Codex replaces Claude in Slack I/O", replace: true, screen: PLAN_SCREEN.text + "\nPRIVATE SCREEN", notice: /現在の会話/ },
    { name: "private unclassified screen", replace: false, screen: "PRIVATE SCREEN", notice: /端末で答えてください/ },
    { name: "visible Claude question", replace: false, screen: QUESTION_SCREEN.text, notice: /❓/ },
  ]) {
    await t.test(scenario.name, async () => {
      await withCore([CLAUDE], { screens: [scenario.screen] }, async (backend, fake) => {
        const messages: { text: string; blocks?: unknown[] }[] = [];
        let seen: () => void;
        const notice = new Promise<void>((resolve) => { seen = resolve; });
        const record = (text: string, blocks?: unknown[]) => {
          messages.push({ text, blocks });
          if (scenario.notice.test(text)) seen();
        };
        const notifier: Notifier = {
          async postReply(_c, _t, text) { record(text); },
          async postMessage(_c, _t, text, blocks) {
            record(text, blocks);
            return {
              async update(update, nextBlocks) {
                if (scenario.replace && update.includes("実行中")) {
                  await delay(5);
                  fake.setTerminal({ agent: "codex", foregroundName: "codex", status: "idle" });
                }
                record(update, nextBlocks);
              },
            };
          },
        };
        const engine = testEngine(backend, notifier);
        try {
          assert.equal(await engine.adoptBlockedTerminal(PAIRING, {
            backend: "herdr-core", driver: claudeDriver, sessionId: "session-101", transcriptPath: "",
            offset: 0, collected: [], paneId: PAIRING.paneId, ref: ref("t1"), cwd: PAIRING.cwd,
            outboxBaseline: {}, writes: new WrittenFileTracker(),
          }), true);
          await Promise.race([notice, delay(4_000, undefined, { ref: false }).then(() => assert.fail("expected notice"))]);
          const calls = fake.calls().map(({ args }) => args);
          assert.deepEqual(calls.map(([command]) => command), scenario.replace ? ["get"] : ["get", "read"]);
          if (!scenario.replace) assert.deepEqual(calls[1], ["read", "--json", "--", "t1"]);
          const output = JSON.stringify(messages);
          assert.doesNotMatch(output, /PRIVATE SCREEN/);
          if (scenario.screen === QUESTION_SCREEN.text) assert.match(output, /action_id/);
          else assert.doesNotMatch(output, /action_id/);
        } finally {
          engine.abortAll();
        }
      });
    });
  }
});

test("a session-backed status-null Claude startup is checked before submit", async (t) => {
  const terminal = { ...CLAUDE, status: null };
  const privateDialog = STARTUP_SCREEN.replace(" Accessing workspace:", "PRIVATE STARTUP SENTINEL")
    .replace("Is this a project you created or one you trust?", "Continue with this setup?");
  for (const scenario of [
    { name: "captured trust dialog", terminal, options: { screens: [STARTUP_SCREEN] }, notice: /このダイアログは端末で答えてください/ },
    { name: "private startup heading", terminal, options: { screens: [privateDialog] }, notice: /このダイアログは端末で答えてください/ },
    { name: "unavailable screen", terminal, options: { readError: true }, notice: /端末の入力欄を確認できません/ },
    { name: "unqualified foreground", terminal: { ...terminal, foregroundName: "zsh" }, options: {}, notice: /端末の入力欄を確認できません/ },
    { name: "foreground changed during capture", terminal, options: {
      screens: [STARTUP_SCREEN],
      terminalAfterRead: { agent: "codex", foregroundName: "codex", status: "idle" },
    }, notice: /端末の入力欄を確認できません/ },
  ]) {
    await t.test(scenario.name, async () => {
      await withCore([scenario.terminal], scenario.options, async (backend, fake) => {
        const replies: string[] = [];
        const engine = testEngine(backend, {
          async postReply(_c, _t, text) { replies.push(text); },
          async postMessage() { assert.fail("a blocked startup should not start a turn"); },
        });
        try {
          await engine.startTurn(PAIRING, "U1", "continue");
          assert.match(replies.join(), scenario.notice);
          assert.doesNotMatch(replies.join(), /PRIVATE STARTUP SENTINEL|Is this a project you created or one you trust\?/);
          const commands = fake.calls().map(({ args }) => args[0]);
          assert.ok(!commands.includes("send"));
          if (scenario.name === "captured trust dialog" || scenario.name === "private startup heading") {
            assert.deepEqual(commands, ["get", "get", "read", "get"]);
          }
        } finally {
          engine.abortAll();
        }
      });
    });
  }
  await t.test("verified visible composer can submit", async () => {
    await withCore([terminal], { screens: [CLAUDE_COMPOSER], send: { started: false } }, async (backend, fake) => {
      const engine = testEngine(backend, {
        async postReply() {},
        async postMessage() { return { async update() {} }; },
      });
      try {
        await engine.startTurn(PAIRING, "U1", "continue");
        assert.deepEqual(fake.calls().map(({ args }) => args[0]), ["get", "get", "read", "get", "get", "send"]);
        assert.deepEqual(fake.calls()[2].args, ["read", "--json", "--", "t1"]);
      } finally {
        engine.abortAll();
      }
    });
  });
});

test("lists local Claude Code terminals with the session id and cwd Claude Code recorded", async () => {
  await withCore(
    [
      { address: "t1", agent: "claude-code", status: "blocked", pid: 101, name: "design", title: " Fix login " },
      { address: "t2", agent: "claude-code", status: null, pid: 102 },
      { address: "t3", agent: "zsh" },
      { address: "box/t4", agent: "claude-code", status: "idle", pid: 104 },
      { address: "t5", agent: "claude-code", status: "done", pid: 105, state: "finished" },
    ],
    {},
    async (backend) => {
      const result = await backend.list();
      assert.deepEqual(result.failures, []);
      assert.equal(result.complete, true);
      assert.deepEqual(result.notices, []);
      assert.deepEqual(
        result.agents.map((a) => [a.ref.target, a.backend, a.agent, a.sessionId, a.cwd, a.evidence, a.terminalTitle, a.displayId]),
        [
          ["hc:t1", "herdr-core", "claude", "session-101", "/repo/t1", { kind: "classified", status: "blocked" }, "Fix login", "design"],
          ["hc:t2", "herdr-core", "claude", "session-102", "/repo/t2", { kind: "classified", status: "unknown" }, null, "t2"],
        ],
      );
    },
  );
});

test("notes agents that report a status but are not Claude Code", async () => {
  await withCore([{ address: "t1", agent: "omp", status: "idle" }], {}, async (backend) => {
    const result = await backend.list();
    assert.deepEqual(result.agents, []);
    assert.deepEqual(result.notices, [HC_UNSUPPORTED_AGENTS_NOTICE]);
  });
});

test("a terminal whose Claude Code has no session record is not offered", async () => {
  await withCore([{ address: "t1", agent: "claude-code", status: "idle" }], {}, async (backend) => {
    assert.deepEqual((await backend.list()).agents, []);
    assert.equal(await backend.get("hc:t1"), null);
    assert.equal(await backend.exists("hc:t1"), true);
  });
});

test("only hc's not_found means gone; a finished terminal is gone too", async () => {
  await withCore([{ address: "t5", agent: "claude-code", status: "done", pid: 105, state: "finished" }], {}, async (backend) => {
    assert.equal(await backend.get("hc:t9"), null);
    assert.equal(await backend.exists("hc:t9"), false);
    assert.equal(await backend.exists("hc:t5"), false);
  });
});

test("a stopped core is reported as unavailable and hc is never run, so cctag cannot start it", async () => {
  const fake = fakeHc([{ address: "t1", agent: "claude-code", status: "idle", pid: 101 }]);
  try {
    const backend = new HcBackend(fake.bin, { socket: fake.socket, sessionsDir: fake.sessionsDir });
    const result = await backend.list();
    assert.equal(result.complete, false);
    assert.equal(result.failures[0]?.backend, "herdr-core");
    assert.match(result.failures[0]?.reason ?? "", /not running/);
    await assert.rejects(backend.get("hc:t1"), BackendUnavailable);
    await assert.rejects(backend.exists("hc:t1"), BackendUnavailable);
    await assert.rejects(backend.submit(ref("t1"), "message", CTX), BackendUnavailable);
    assert.deepEqual(fake.calls(), []);
  } finally {
    await fake.cleanup();
  }
});

test("hc runs without the Spoke's own HC_TERMINAL_ID, HC_SCOPE or HC_TERMINAL_SOCKET", async () => {
  const saved = { id: process.env.HC_TERMINAL_ID, scope: process.env.HC_SCOPE, socket: process.env.HC_TERMINAL_SOCKET };
  process.env.HC_TERMINAL_ID = "t99";
  process.env.HC_SCOPE = "scope";
  process.env.HC_TERMINAL_SOCKET = "/old/terminal.sock";
  try {
    await withCore([{ address: "t1", agent: "claude-code", status: "idle", pid: 101 }], {}, async (backend, fake) => {
      await backend.submit(ref("t1"), "hello", CTX);
      const send = fake.calls().find((call) => call.args[0] === "send");
      assert.deepEqual(send?.args, ["send", "--json", "--", "t1", "hello"]);
      assert.deepEqual(send?.env, { HC_SOCKET: fake.socket }, "hc uses the same socket that cctag probes");
    });
  } finally {
    if (saved.id === undefined) delete process.env.HC_TERMINAL_ID;
    else process.env.HC_TERMINAL_ID = saved.id;
    if (saved.scope === undefined) delete process.env.HC_SCOPE;
    else process.env.HC_SCOPE = saved.scope;
    if (saved.socket === undefined) delete process.env.HC_TERMINAL_SOCKET;
    else process.env.HC_TERMINAL_SOCKET = saved.socket;
  }
});

test("a message that starts with a hyphen is sent as text, not read as a flag", async () => {
  await withCore([{ address: "t1" }], {}, async (backend, fake) => {
    await backend.submit(ref("t1"), "--force", CTX);
    await backend.submit(ref("t1"), "-1 for that", CTX);
    assert.deepEqual(
      fake.calls().filter((call) => call.args[0] === "send").map((call) => call.args),
      [
        ["send", "--json", "--", "t1", "--force"],
        ["send", "--json", "--", "t1", "-1 for that"],
      ],
    );
  });
});

test("submit reports whether the agent started a turn", async () => {
  await withCore([{ address: "t1" }], { send: { started: true, status: "working", turn: 2 } }, async (backend) => {
    assert.deepEqual(await backend.submit(ref("t1"), "go", CTX), { status: "started", draftStashed: false });
  });
  await withCore([{ address: "t1" }], { send: { started: false, status: "idle", turn: 1 } }, async (backend) => {
    assert.deepEqual(await backend.submit(ref("t1"), "/model", CTX), { status: "accepted", draftStashed: false });
  });
});

test("submit turns hc's refusal of a blocked terminal into a gate refusal, and other failures into an unknown outcome", async () => {
  await withCore([{ address: "t1" }], { send: { error: { kind: "blocked", message: "t1 is blocked (permission)" } } }, async (backend) => {
    await assert.rejects(backend.submit(ref("t1"), "go", CTX), (err: unknown) => err instanceof SubmitRefused && err.reason === "gate");
  });
  await withCore([{ address: "t1" }], { send: { error: { kind: "unavailable", message: "the core is stopping" } } }, async (backend) => {
    await assert.rejects(backend.submit(ref("t1"), "go", CTX), WriteOutcomeUnknown);
  });
});

test("hc reads only the visible screen for either region and strips the side pane", async () => {
  await withCore([CLAUDE], { screens: [QUESTION_SCREEN.text] }, async (backend, fake) => {
    const screen = await backend.read("hc:t1", 200, "screen");
    await backend.read("hc:t1", 200, "history");
    assert.deepEqual(
      fake.calls().filter((call) => call.args[0] === "read").map((call) => call.args),
      [
        ["read", "--json", "--", "t1"],
        ["read", "--json", "--", "t1"],
      ],
    );
    assert.equal(screen.complete, true);
    assert.ok(!screen.text.includes("AI解説"), "the qa-guide pane is stripped");
  });
});

test("a polling read uses one hc command with the current Claude observation and discards it after use", async () => {
  await withCore([CLAUDE], { screens: [QUESTION_SCREEN.text, "private"], terminalAfterRead: { status: null, foregroundName: "zsh" } }, async (backend, fake) => {
    const agent = await backend.get("hc:t1");
    assert.ok(agent);
    assert.equal((await backend.read("hc:t1", 200, "history", agent)).text, stripSidePane(QUESTION_SCREEN.text));
    assert.deepEqual(fake.calls().map(({ args }) => args[0]), ["get", "read"]);
    assert.deepEqual(fake.calls()[1].args, ["read", "--json", "--", "t1"]);
    assert.deepEqual(await backend.read("hc:t1", 200, "history", agent), { text: "", draft: null, complete: false });
    assert.deepEqual(fake.calls().map(({ args }) => args[0]), ["get", "read", "get"]);
  });
});

test("a qualified Claude read propagates a read failure without another get", async () => {
  await withCore([CLAUDE], { readError: true }, async (backend, fake) => {
    const agent = await backend.get("hc:t1");
    assert.ok(agent);
    await assert.rejects(backend.read("hc:t1", 0, "screen", agent), /screen unavailable/);
    assert.deepEqual(fake.calls().map(({ args }) => args[0]), ["get", "read"]);
  });
});

test("a newer unqualified poll cannot reuse an unconsumed Claude observation", async () => {
  await withCore([CLAUDE], { terminalAfterRead: { foregroundName: "zsh", status: null } }, async (backend, fake) => {
    const earlier = await backend.get("hc:t1");
    assert.ok(earlier);
    await backend.read("hc:t1", 0, "screen");
    const current = await backend.get("hc:t1");
    assert.ok(current);
    for (const observation of [current, earlier]) {
      const snapshot = await backend.read("hc:t1", 200, "history", observation);
      assert.equal(snapshot.text, "");
    }
    assert.equal(fake.calls().filter(({ args }) => args[0] === "read").length, 1);
  });
});

test("an unobserved read with a replaced Claude foreground withholds the screen and a stale answer sends no keys", async () => {
  const terminalAfterRead = { agent: "codex", foregroundName: "codex", status: "blocked", kind: "question" };
  await withCore([CLAUDE], { screens: [CODEX_QUESTION], terminalAfterRead }, async (backend) => {
    assert.deepEqual(await backend.read("hc:t1", 0, "screen"), { text: "", draft: null, complete: false });
  });
  await withCore([CLAUDE], { screens: [QUESTION_SCREEN.text], terminalAfterRead }, async (backend, fake) => {
    const channel = backend.openAnswer(ref("t1"), verified(stripSidePane(QUESTION_SCREEN.text)));
    await assert.rejects(channel.digit(1), ExpectationLost);
    assert.deepEqual(fake.calls().map(({ args }) => args[0]), ["get", "read", "get"]);
  });
});

test("fresh Codex blocked status produces a generic prompt when no current form can be verified", async () => {
  const terminal = { address: "t1", agent: "codex", foregroundName: "codex", status: "blocked", kind: "question", pid: 101, turn: 3 };
  for (const options of [
    { screens: [CODEX_QUESTION], incomplete: true },
    { screens: [CODEX_QUESTION + "\n› Ask Codex to do anything"] },
    { screens: ["private unclassified prompt"] },
    { readError: true },
  ]) {
    await withCore([terminal], options, async (backend) => {
      assert.deepEqual(await backend.read("hc:t1", 0, "screen"), {
        text: "", draft: null, complete: false, observedPrompt: { kind: "input", fingerprint: "input", turn: 3 },
      });
    });
  }
  await withCore([terminal], { screens: [CODEX_QUESTION], terminalAfterRead: { status: "working" } }, async (backend) => {
    assert.deepEqual(await backend.read("hc:t1", 0, "screen"), { text: "", draft: null, complete: false });
  });
  await withCore([{ ...terminal, pid: undefined }], { screens: [CODEX_QUESTION] }, async (backend) => {
    assert.deepEqual(await backend.read("hc:t1", 0, "screen"), {
      text: "", draft: null, complete: false, observedPrompt: { kind: "input", fingerprint: "input", turn: 3 },
    });
  });
});

test("foreground-only Codex can report the measured trust screen on an existing terminal", async () => {
  const terminal = { address: "t1", agent: "env", foregroundName: "codex", status: null, pid: 101, turn: 7 };
  const moved = CODEX_TRUST.replace("› 1.", "  1.").replace("  2.", "› 2.");
  await withCore([terminal], {
    screens: [CODEX_TRUST, moved, CODEX_TRUST + "\n› Ask Codex to do anything", CODEX_COMPOSER],
  }, async (backend, fake) => {
    const notice = {
      text: "", draft: null, complete: false, observedPrompt: { kind: "trust", fingerprint: "trust", turn: 7 },
    };
    assert.deepEqual(await backend.read("hc:t1", 0, "screen"), notice);
    assert.deepEqual(await backend.read("hc:t1", 0, "screen"), notice);
    assert.deepEqual(await backend.read("hc:t1", 0, "screen"), { text: "", draft: null, complete: false });
    assert.deepEqual(await backend.read("hc:t1", 0, "screen"), { text: "", draft: null, complete: false, codexTrustExited: true });
    await assert.rejects(backend.openComposer(ref("t1"), claudeDriver).backTab(), ExpectationLost);
    assert.ok(fake.calls().every(({ args }) => args[0] !== "keys" && args[0] !== "send"));
  });
});

test("the captured hc screens parse as a question and a plan approval", () => {
  const question = claudeDriver.parseBlockedPane(stripSidePane(QUESTION_SCREEN.text));
  assert.equal(question.kind, "question");
  assert.equal(claudeDriver.parseBlockedPane(PLAN_SCREEN.text).kind, "permission");
});

test("an answer checks the prompt is still on screen, then presses keys by hc's key names", async () => {
  await withCore([CLAUDE], { screens: [QUESTION_SCREEN.text] }, async (backend, fake) => {
    const prompt = verified(stripSidePane(QUESTION_SCREEN.text));
    const channel = backend.openAnswer(ref("t1"), prompt);
    await channel.move("Down", 2);
    await channel.digit(1, false);
    await channel.confirm("Amber");
    const writes = fake.calls().filter((call) => call.args[0] === "keys" || call.args[0] === "send").map((call) => call.args);
    assert.deepEqual(writes, [
      ["keys", "--json", "--", "t1", "down", "down"],
      ["keys", "--json", "--", "t1", "1"],
      ["keys", "--json", "--", "t1", "enter"],
    ]);
    assert.equal(fake.calls().filter((call) => call.args[0] === "read").length, 1);
    assert.deepEqual(fake.calls().map(({ args }) => args[0]), ["get", "read", "get", "get", "keys", "get", "keys", "get", "keys"]);
  });
});

test("a matching answer fingerprint on an incomplete hc screen authorizes no input", async () => {
  await withCore([CLAUDE], { screens: [QUESTION_SCREEN.text], incomplete: true }, async (backend, fake) => {
    const channel = backend.openAnswer(ref("t1"), verified(stripSidePane(QUESTION_SCREEN.text)));
    await assert.rejects(channel.digit(1), ExpectationLost);
    assert.deepEqual(fake.calls().map(({ args }) => args[0]), ["get", "read", "get"]);
  });
});

test("typed text is pasted together with its Enter, and nothing else may follow it", async () => {
  await withCore([CLAUDE], { screens: [QUESTION_SCREEN.text] }, async (backend, fake) => {
    const prompt = verified(stripSidePane(QUESTION_SCREEN.text));
    const channel = backend.openAnswer(ref("t1"), prompt);
    await channel.move("Down", 2);
    await channel.text("Cが好き");
    await channel.confirm("Cが好き");
    assert.deepEqual(
      fake.calls().filter((call) => call.args[0] === "keys" || call.args[0] === "send").map((call) => call.args),
      [
        ["keys", "--json", "--", "t1", "down", "down"],
        ["send", "--force", "--json", "--", "t1", "Cが好き"],
      ],
    );
  });
  await withCore([{ address: "t1" }], { screens: [QUESTION_SCREEN.text] }, async (backend, fake) => {
    const channel = backend.openAnswer(ref("t1"), verified(stripSidePane(QUESTION_SCREEN.text)));
    await channel.text("1,3");
    await assert.rejects(channel.move("Down", 1), (err: unknown) => err instanceof ExpectationLost && err.userMessage === HC_TYPED_TEXT_UNSUPPORTED);
    assert.deepEqual(fake.calls(), [], "nothing was written");
  });
});

test("an answer is refused when the prompt on screen is no longer the verified one", async () => {
  await withCore([CLAUDE], { screens: [PLAN_SCREEN.text] }, async (backend, fake) => {
    const channel = backend.openAnswer(ref("t1"), verified(stripSidePane(QUESTION_SCREEN.text)));
    await assert.rejects(channel.digit(1), ExpectationLost);
    assert.deepEqual(fake.calls().filter((call) => call.args[0] === "keys" || call.args[0] === "send"), []);
  });
});

test("Shift+Tab and blind y/n answers use hc's key names", async () => {
  await withCore([{ address: "t1" }], {}, async (backend, fake) => {
    await backend.openComposer(ref("t1"), claudeDriver).backTab();
    await backend.openBlind(ref("t1"), { form: "key-then-enter" } as never).answer("y");
    assert.deepEqual(
      fake.calls().filter((call) => call.args[0] === "keys").map((call) => call.args),
      [
        ["keys", "--json", "--", "t1", "shift+tab"],
        ["keys", "--json", "--", "t1", "y"],
        ["keys", "--json", "--", "t1", "enter"],
      ],
    );
  });
});

test("a multi-select free-text answer on herdr-core is refused before any key is sent", async () => {
  const writes: string[] = [];
  const record = (name: string) => async () => {
    writes.push(name);
  };
  const channel = {
    digit: record("digit"),
    text: record("text"),
    move: record("move"),
    confirm: record("confirm"),
    complete: () => writes.push("complete"),
  };
  const info = { header: "Q", question: "Which?", multiSelect: true, options: [{ label: "A" }, { label: "B" }] };
  await assert.rejects(
    claudeDriver.answerQuestionFreeText!({} as never, channel, ref("t1"), info as never, "A and B", new AbortController().signal),
    (err: unknown) => err instanceof ExpectationLost && /複数選択/.test(err.userMessage ?? ""),
  );
  assert.deepEqual(writes, []);
});

test("plan feedback moves to the option, then pastes the feedback with its Enter", async () => {
  await withCore([CLAUDE], { screens: [PLAN_SCREEN.text] }, async (backend, fake) => {
    const prompt = verified(PLAN_SCREEN.text);
    const channel = backend.openAnswer(ref("t1"), prompt);
    await claudeDriver.answerPlanFeedback!(channel, 3, "改行1つだけにして");
    assert.deepEqual(
      fake.calls().filter((call) => call.args[0] === "keys" || call.args[0] === "send").map((call) => call.args),
      [
        ["keys", "--json", "--", "t1", "3"],
        ["send", "--force", "--json", "--", "t1", "改行1つだけにして"],
      ],
    );
  });
});

test("hc Codex stays live and unbound, and every backend input path refuses", async () => {
  await withCore([{ address: "t1", agent: "codex", status: "blocked", kind: "question", pid: 101, turn: 4 }], { screens: [CODEX_QUESTION] }, async (backend, fake) => {
    const agent = await backend.get("hc:t1");
    assert.ok(agent);
    assert.equal(agent.agent, "codex");
    assert.equal(agent.turn, 4);
    assert.equal(agent.cwd, "/moved/here");
    const snapshot = await backend.read("hc:t1", 200, "history");
    assert.equal(snapshot.text, "");
    assert.equal(snapshot.complete, false);
    assert.equal(snapshot.observedPrompt?.kind, "question");
    assert.equal(fake.calls().find(({ args }) => args[0] === "read")?.args.includes("--lines"), false);
    assert.equal((await codexDriver.runModelCommand(backend, agent, "gpt-6.2-sol")).submitOutcome, null);
    assert.equal(agent?.sessionId, null);
    assert.equal(agent?.transcriptIdentity, undefined);
    assert.equal(await backend.exists("hc:t1"), true);
    assert.equal((await backend.list()).agents.length, 0);
    assert.match((await backend.list()).notices.join(), /現在の会話/);
    const prompt = verified(stripSidePane(QUESTION_SCREEN.text));
    await assert.rejects(backend.submit(ref("t1"), "try to send", CTX), SubmitRefused);
    await assert.rejects(backend.openAnswer(ref("t1"), prompt).digit(1), ExpectationLost);
    const answer = backend.openAnswer(ref("t1"), prompt);
    await assert.rejects(answer.move("Down", 1), ExpectationLost);
    await assert.rejects(answer.confirm("Amber"), ExpectationLost);
    await assert.rejects(backend.openBlind(ref("t1"), { driver: claudeDriver, form: "key-confirms" } as never).answer("y"), ExpectationLost);
    await assert.rejects(backend.openComposer(ref("t1"), claudeDriver).backTab(), ExpectationLost);
    const model = parseCodexModelMenuPrompt(MODEL_SCREEN);
    assert.ok(model);
    const beforeModelAnswer = fake.calls().length;
    await assert.rejects(backend.openModelAnswer(ref("t1"), model).escape(), ExpectationLost);
    assert.equal(fake.calls().length, beforeModelAnswer);
    assert.deepEqual(fake.calls().filter(({ args }) => args[0] === "send" || args[0] === "keys"), []);
  });
});

test("a Codex foreground executable triggers refusal without app metadata", async () => {
  await withCore(
    [{ address: "t1", agent: "env", status: null, pid: 101, foregroundName: "/opt/homebrew/bin/codex", foregroundCwd: null }],
    { screens: [CODEX_QUESTION] },
    async (backend, fake) => {
      const agent = await backend.get("hc:t1");
      assert.equal(agent?.agent, "codex");
      assert.equal(agent?.cwd, "", "the terminal creation cwd does not establish live ownership");
      const listing = await backend.list();
      assert.deepEqual(listing.agents, []);
      assert.equal(listing.notices.length, 1);
      assert.match(listing.notices[0], /現在の会話/);
      assert.match(JSON.stringify(agentPickerBlocks(listing, ["herdr-core"])), /現在の会話/);
      assert.equal((await backend.read("hc:t1", 200, "history")).text, "");
      await assert.rejects(backend.submit(ref("t1"), "try to send", CTX), SubmitRefused);
      const prompt = verified(stripSidePane(QUESTION_SCREEN.text));
      await assert.rejects(backend.openAnswer(ref("t1"), prompt).digit(1), ExpectationLost);
      assert.deepEqual(fake.calls().filter(({ args }) => args[0] === "send" || args[0] === "keys"), []);
    },
  );
});
