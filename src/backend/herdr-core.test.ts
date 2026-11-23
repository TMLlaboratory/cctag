import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandHandler } from "../commands.js";
import type { Notifier } from "../notifier.js";
import type { Pairing, PairingStore } from "../pairing.js";
import { TurnEngine } from "../turn.js";
import { claudeDriver } from "../agents/claude/driver.js";
import { stripSidePane } from "./side-pane.js";
import { HcBackend, HC_TYPED_TEXT_UNSUPPORTED, HC_UNSUPPORTED_AGENTS_NOTICE } from "./herdr-core.js";
import { createTerminals, type SubmitContext, type Terminals } from "./index.js";
import { createBlindPermissionPrompt, type VerifiedPrompt } from "./prompt.js";
import { BackendUnavailable, CoreNotRunning, ExpectationLost, SubmitRefused, WriteOutcomeUnknown, type AgentRef } from "./types.js";

const FIXTURES = new URL("../agents/claude/__fixtures__/", import.meta.url);
const QUESTION_SCREEN = JSON.parse(readFileSync(new URL("hc-question.screen.json", FIXTURES), "utf8")) as { text: string };
const PLAN_SCREEN = JSON.parse(readFileSync(new URL("hc-plan-approval.screen.json", FIXTURES), "utf8")) as { text: string };
const MODEL_SWITCH = JSON.parse(
  readFileSync(new URL("hc-model-switch-confirmation.screen.json", FIXTURES), "utf8"),
) as { text: string; capture: { status: string } };

interface FakeTerminal {
  address: string;
  agent?: string;
  state?: string;
  status?: string | null;
  pid?: number;
  foregroundName?: string;
  name?: string | null;
  title?: string;
}

interface Fake {
  bin: string;
  socket: string;
  sessionsDir: string;
  calls(): { args: string[]; env: Record<string, string | undefined> }[];
  setTerminal(changes: Partial<FakeTerminal>): void;
  startCore(): Promise<void>;
  cleanup(): Promise<void>;
}

/**
 * A stand-in for `hc` that answers from a JSON table, errors the way hc does
 * (a JSON error on stderr and a non-zero exit), and records every call with
 * the HC_* variables it saw.
 */
function fakeHc(
  terminals: FakeTerminal[],
  options: { screens?: string[]; incomplete?: boolean; send?: Record<string, unknown> | { error: { kind: string; message: string } } } = {},
): Fake {
  const dir = mkdtempSync(join(tmpdir(), "cctag-hc-"));
  const bin = join(dir, "hc");
  const callsFile = join(dir, "calls.jsonl");
  const terminalChanges = join(dir, "terminal-changes.json");
  const readCount = join(dir, "read-count");
  const sessionsDir = join(dir, "sessions");
  mkdirSync(sessionsDir);
  for (const t of terminals) {
    if (t.pid !== undefined) {
      writeFileSync(join(sessionsDir, `${t.pid}.json`), JSON.stringify({ pid: t.pid, startedAt: 101_000, sessionId: `session-${t.pid}`, cwd: `/repo/${t.address}` }));
    }
  }
  const script = `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const ops = args.includes("--") ? args.slice(args.indexOf("--") + 1) : [];
const env = { HC_SOCKET: process.env.HC_SOCKET, HC_TERMINAL_ID: process.env.HC_TERMINAL_ID, HC_SCOPE: process.env.HC_SCOPE, HC_TERMINAL_SOCKET: process.env.HC_TERMINAL_SOCKET };
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ args, env }) + "\\n");
const terminals = ${JSON.stringify(terminals)};
const screens = ${JSON.stringify(options.screens ?? ["screen text"])};
const send = ${JSON.stringify(options.send ?? { started: true, status: "working", turn: 2 })};
const fail = (kind, message, code) => { process.stderr.write(JSON.stringify({ error: { kind, message } })); process.exit(code); };
const find = (address) => terminals.find((t) => t.address === address) ?? fail("not_found", "no terminal " + address, 3);
const out = (value) => process.stdout.write(JSON.stringify(value));
if (args[0] === "ls") {
  out({ terminals: terminals.map((t) => ({ address: t.address, agent: t.agent, state: t.state ?? "live", ...(t.status === undefined ? {} : { status: t.status }) })) });
} else if (args[0] === "get") {
  const t = { ...find(ops[0]), ...(fs.existsSync(${JSON.stringify(terminalChanges)})
    ? JSON.parse(fs.readFileSync(${JSON.stringify(terminalChanges)}, "utf8")) : {}) };
  out({
    address: t.address, name: t.name ?? null, cwd: "/created/here", state: t.state ?? "live", title: t.title ?? "",
    foreground: t.pid === undefined ? null : { pid: t.pid, cwd: "/moved/here", name: t.foregroundName ?? "claude" },
    status: t.status == null ? null : { app: t.agent, state: t.status },
  });
} else if (args[0] === "read") {
  find(ops[0]);
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
    calls: () =>
      existsSync(callsFile)
        ? readFileSync(callsFile, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [],
    setTerminal: (changes) => writeFileSync(terminalChanges, JSON.stringify(changes)),
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

const CLAUDE = { address: "t1", agent: "claude-code", status: "blocked", pid: 101 };
const BLIND = createBlindPermissionPrompt(claudeDriver, "key-confirms");

function writes(fake: Fake): string[][] {
  return fake.calls().filter(({ args }) => args[0] === "keys" || args[0] === "send").map(({ args }) => args);
}

function ref(address: string): AgentRef {
  return { target: `hc:${address}`, pid: 101, processStartedAt: 101_000, sessionId: "session-101" };
}

function verified(screen: string): VerifiedPrompt {
  const parsed = claudeDriver.parseBlockedPane(screen);
  if (parsed.kind !== "question" && parsed.kind !== "permission") throw new Error(`expected a prompt, got ${parsed.kind}`);
  return parsed.verified;
}

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
  await withCore([{ address: "t1", agent: "codex", status: "idle" }], {}, async (backend) => {
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
    await assert.rejects(backend.list(), CoreNotRunning);
    const result = await createTerminals({ herdr: null, orca: null, "herdr-core": backend }).list();
    assert.equal(result.complete, false);
    assert.equal(result.failures[0]?.backend, "herdr-core");
    assert.match(result.failures[0]?.reason ?? "", /not running/);
    await assert.rejects(backend.get("hc:t1"), BackendUnavailable);
    await assert.rejects(backend.exists("hc:t1"), BackendUnavailable);
    assert.deepEqual(fake.calls(), []);
  } finally {
    await fake.cleanup();
  }
});

test("hc uses the probed socket without inheriting the Spoke's terminal context", async () => {
  const inherited = { HC_SOCKET: "/unrelated/core.sock", HC_TERMINAL_ID: "t99", HC_SCOPE: "scope", HC_TERMINAL_SOCKET: "/unrelated/t99.sock" };
  const saved = Object.keys(inherited).map((key) => [key, process.env[key]] as const);
  Object.assign(process.env, inherited);
  try {
    await withCore([{ address: "t1", agent: "claude-code", status: "idle", pid: 101 }], {}, async (backend, fake) => {
      await backend.submit(ref("t1"), "hello", CTX);
      const send = fake.calls().find((call) => call.args[0] === "send");
      assert.deepEqual(send?.args, ["send", "--json", "--", "t1", "hello"]);
      assert.ok(fake.calls().every(({ env }) => env.HC_SOCKET === fake.socket));
      assert.deepEqual(send?.env, { HC_SOCKET: fake.socket });
    });
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("a message that starts with a hyphen is sent as text, not read as a flag", async () => {
  await withCore([CLAUDE], {}, async (backend, fake) => {
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

test("submit observes cancellation after the foreground check and sends nothing", async () => {
  await withCore([CLAUDE], {}, async (backend, fake) => {
    await assert.rejects(backend.submit(ref("t1"), "cancel this", {
      ...CTX,
      cancelled() {
        assert.deepEqual(fake.calls().map(({ args }) => args[0]), ["get"]);
        return true;
      },
    }), (error: unknown) => error instanceof SubmitRefused && error.reason === "cancelled");
    assert.deepEqual(writes(fake), []);
  });
});

test("submit reports whether the agent started a turn", async () => {
  await withCore([CLAUDE], { send: { started: true, status: "working", turn: 2 } }, async (backend) => {
    assert.deepEqual(await backend.submit(ref("t1"), "go", CTX), { status: "started", draftStashed: false });
  });
  await withCore([CLAUDE], { send: { started: false, status: "idle", turn: 1 } }, async (backend) => {
    assert.deepEqual(await backend.submit(ref("t1"), "/model", CTX), { status: "accepted", draftStashed: false });
  });
});

test("submit turns hc's refusal of a blocked terminal into a gate refusal, and other failures into an unknown outcome", async () => {
  await withCore([CLAUDE], { send: { error: { kind: "blocked", message: "t1 is blocked (permission)" } } }, async (backend) => {
    await assert.rejects(backend.submit(ref("t1"), "go", CTX), (err: unknown) => err instanceof SubmitRefused && err.reason === "gate");
  });
  await withCore([CLAUDE], { send: { error: { kind: "unavailable", message: "the core is stopping" } } }, async (backend) => {
    await assert.rejects(backend.submit(ref("t1"), "go", CTX), WriteOutcomeUnknown);
  });
});

test("read asks for history lines only for the history region and strips the side pane", async () => {
  await withCore([CLAUDE], { screens: [QUESTION_SCREEN.text] }, async (backend, fake) => {
    const screen = await backend.read("hc:t1", 200, "screen");
    await backend.read("hc:t1", 200, "history");
    assert.deepEqual(
      fake.calls().filter((call) => call.args[0] === "read").map((call) => call.args),
      [
        ["read", "--json", "--", "t1"],
        ["read", "--lines", "200", "--json", "--", "t1"],
      ],
    );
    assert.equal(screen.complete, true);
    assert.ok(!screen.text.includes("AI解説"), "the qa-guide pane is stripped");
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
    assert.deepEqual(writes(fake), [
      ["keys", "--json", "--", "t1", "down", "down"],
      ["keys", "--json", "--", "t1", "1"],
      ["keys", "--json", "--", "t1", "enter"],
    ]);
    assert.deepEqual(fake.calls().map(({ args }) => args[0]), ["get", "read", "get", "keys", "get", "keys", "get", "keys"]);
    assert.deepEqual(fake.calls()[1]?.args, ["read", "--json", "--", "t1"]);
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
      writes(fake),
      [
        ["keys", "--json", "--", "t1", "down", "down"],
        ["send", "--force", "--json", "--", "t1", "Cが好き"],
      ],
    );
  });
  await withCore([CLAUDE], { screens: [QUESTION_SCREEN.text] }, async (backend, fake) => {
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
    assert.deepEqual(writes(fake), []);
  });
});

test("a matching prompt on an incomplete visible screen authorizes no input", async () => {
  await withCore([CLAUDE], { screens: [PLAN_SCREEN.text], incomplete: true }, async (backend, fake) => {
    await assert.rejects(backend.openAnswer(ref("t1"), verified(PLAN_SCREEN.text)).digit(1), /screen is incomplete/);
    assert.deepEqual(fake.calls().map(({ args }) => args[0]), ["get", "read"]);
  });
});

test("a replaced Claude foreground or session refuses submit, answers, and Shift+Tab", async (t) => {
  for (const [name, terminal, session, notice] of [
    ["different PID", { pid: 202 }, {}, /セッションが切り替わりました/],
    ["different session", {}, { sessionId: "replacement" }, /セッションが切り替わりました/],
    ["different start time", {}, { startedAt: 102_000 }, /セッションが切り替わりました/],
    ["non-Claude executable with stale Claude status", { foregroundName: "zsh" }, {}, /前景で Claude Code/],
    ["different status app", { agent: "other" }, {}, /前景で Claude Code/],
    ["mismatched PID in session file", {}, { pid: 999 }, /前景で Claude Code/],
    ["unverified start time", {}, { startedAt: null }, /前景で Claude Code/],
  ] as const) {
    await t.test(name, async () => {
      await withCore([CLAUDE], {}, async (backend, fake) => {
        const agent = await backend.get("hc:t1");
        assert.ok(agent);
        assert.deepEqual(agent.ref, ref("t1"));
        fake.setTerminal(terminal);
        writeFileSync(join(fake.sessionsDir, "101.json"), JSON.stringify({
          pid: 101, sessionId: "session-101", cwd: "/repo/t1", startedAt: 101_000, ...session,
        }));
        const stale = (error: unknown) => error instanceof ExpectationLost && notice.test(error.userMessage ?? "");
        await assert.rejects(backend.submit(agent.ref, "/model", CTX), (error: unknown) =>
          error instanceof SubmitRefused && error.reason === "agent-unverified" && notice.test(error.message));
        await assert.rejects(backend.openAnswer(agent.ref, verified(PLAN_SCREEN.text)).digit(1), stale);
        await assert.rejects(backend.openComposer(agent.ref, claudeDriver).backTab(), stale);
        assert.deepEqual(writes(fake), []);
      });
    });
  }
});

test("an answer rechecks the blocked state after reading the prompt", async () => {
  await withCore([CLAUDE], { screens: [PLAN_SCREEN.text] }, async (backend, fake) => {
    const prompt = verified(PLAN_SCREEN.text);
    const driver = {
      ...claudeDriver,
      parseBlockedPane(text: string) {
        fake.setTerminal({ status: "idle" });
        return claudeDriver.parseBlockedPane(text);
      },
    };
    await assert.rejects(backend.openAnswer(ref("t1"), { ...prompt, driver }).digit(1), /入力待ち状態が変わりました/);
    assert.deepEqual(fake.calls().map(({ args }) => args[0]), ["get", "read", "get"]);
    await assert.rejects(backend.openAnswer(ref("t1"), prompt).digit(1), /入力待ち状態が変わりました/);
    assert.deepEqual(fake.calls().map(({ args }) => args[0]), ["get", "read", "get", "get"]);
  });
});

test("a compound answer rechecks the session and blocked state before a forced send", async () => {
  for (const change of ["session", "status"]) {
    await withCore([CLAUDE], { screens: [PLAN_SCREEN.text] }, async (backend, fake) => {
      const answer = backend.openAnswer(ref("t1"), verified(PLAN_SCREEN.text));
      await answer.digit(3, false);
      await answer.text("feedback");
      if (change === "status") {
        fake.setTerminal({ status: "idle" });
      } else {
        writeFileSync(join(fake.sessionsDir, "101.json"), JSON.stringify({
          pid: 101, sessionId: "session-101", cwd: "/repo/t1", startedAt: 102_000,
        }));
      }
      await assert.rejects(answer.confirm("Tell Claude what to change"),
        change === "status" ? /入力待ち状態が変わりました/ : /セッションが切り替わりました/);
      assert.deepEqual(fake.calls().map(({ args }) => args[0]), ["get", "read", "get", "keys", "get"]);
    });
  }
});

test("a stale blind permission click sends no keys even while blocked", async () => {
  await withCore([CLAUDE], {}, async (backend, fake) => {
    await assert.rejects(backend.openBlind(ref("t1"), BLIND).answer("y"), (error: unknown) =>
      error instanceof ExpectationLost && /ターミナルで回答/.test(error.userMessage ?? ""));
    assert.deepEqual(fake.calls(), []);
  });
});

test("Shift+Tab uses hc's key name after verifying the foreground", async () => {
  await withCore([CLAUDE], {}, async (backend, fake) => {
    await backend.openComposer(ref("t1"), claudeDriver).backTab();
    assert.deepEqual(writes(fake), [["keys", "--json", "--", "t1", "shift+tab"]]);
  });
});

test("the Claude model command confirms the captured switch menu on done", async () => {
  await withCore([{ ...CLAUDE, status: MODEL_SWITCH.capture.status }], {
    screens: [MODEL_SWITCH.text, MODEL_SWITCH.text, ""],
  }, async (backend, fake) => {
    const terminals = createTerminals({ herdr: null, orca: null, "herdr-core": backend });
    const agent = await terminals.get("hc:t1");
    assert.ok(agent);
    await claudeDriver.runModelCommand!(terminals, agent, "sonnet");
    assert.deepEqual(writes(fake), [
      ["send", "--json", "--", "t1", "/model sonnet"],
      ["keys", "--json", "--", "t1", "1"],
    ]);
    const calls = fake.calls().map(({ args }) => args);
    const keyIndex = calls.findIndex(([command]) => command === "keys");
    assert.deepEqual(calls.slice(keyIndex - 3, keyIndex), [
      ["get", "--json", "--", "t1"],
      ["read", "--json", "--", "t1"],
      ["get", "--json", "--", "t1"],
    ]);
  });
});

test("done does not authorize ordinary permissions or a model confirmation without the model command", async () => {
  await withCore([{ ...CLAUDE, status: "done" }], { screens: [PLAN_SCREEN.text] }, async (backend, fake) => {
    await assert.rejects(backend.openAnswer(ref("t1"), verified(MODEL_SWITCH.text)).digit(1), /入力待ち状態が変わりました/);
    await assert.rejects(backend.openAnswer(ref("t1"), verified(PLAN_SCREEN.text), "claude-model-switch").digit(1), /入力待ち状態が変わりました/);
    assert.deepEqual(writes(fake), []);
  });
});

test("a model confirmation refuses if its observed done state changes during the screen read", async () => {
  await withCore([{ ...CLAUDE, status: "done" }], { screens: [MODEL_SWITCH.text] }, async (backend, fake) => {
    const prompt = verified(MODEL_SWITCH.text);
    const driver = {
      ...claudeDriver,
      parseBlockedPane(text: string) {
        fake.setTerminal({ status: "blocked" });
        return claudeDriver.parseBlockedPane(text);
      },
    };
    await assert.rejects(backend.openAnswer(ref("t1"), { ...prompt, driver }, "claude-model-switch").digit(1), /入力待ち状態が変わりました/);
    assert.deepEqual(fake.calls().map(({ args }) => args[0]), ["get", "read", "get"]);
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
      writes(fake),
      [
        ["keys", "--json", "--", "t1", "3"],
        ["send", "--force", "--json", "--", "t1", "改行1つだけにして"],
      ],
    );
  });
});

test("installed hc joins discovery only when its socket is active or core is required", async () => {
  const fake = fakeHc([{ address: "t1", agent: "claude-code", status: "idle", pid: 101 }]);
  try {
    const core = new HcBackend(fake.bin, { socket: fake.socket, sessionsDir: fake.sessionsDir });
    const legacyAgent = (target: string, backend: "herdr" | "orca") => ({
      ref: { target, pid: null, processStartedAt: null },
      backend,
      agent: "claude" as const,
      cwd: "/sample",
      sessionId: "sample",
      evidence: { kind: "classified" as const, status: "idle" as const },
      terminalTitle: null,
      terminalId: target,
      displayId: target,
    });
    const herdrAgent = legacyAgent("w1:p1", "herdr");
    const orcaAgent = legacyAgent("orca:w1:p1", "orca");
    const mock = (agent: typeof herdrAgent): Terminals => ({
      async list() { return { agents: [agent], failures: [], complete: true, notices: [] }; },
      async get() { return agent; },
      async exists() { return true; },
      async read() { throw new Error("unexpected read"); },
      async submit() { throw new Error("unexpected submit"); },
      openAnswer() { throw new Error("unexpected answer"); },
      openModelAnswer() { throw new Error("unexpected model answer"); },
      openBlind() { throw new Error("unexpected blind answer"); },
      openComposer() { throw new Error("unexpected composer"); },
    });
    const terminals = createTerminals({ herdr: mock(herdrAgent), orca: mock(orcaAgent), "herdr-core": core });
    assert.deepEqual(await terminals.list(), {
      agents: [herdrAgent, orcaAgent], failures: [], complete: true, notices: [],
    });
    assert.equal(await terminals.get(herdrAgent.ref.target), herdrAgent);
    assert.equal(await terminals.get(orcaAgent.ref.target), orcaAgent);
    assert.equal((await terminals.list("herdr-core")).complete, false);

    const pairings: Pairing[] = [];
    const store = {
      list: () => pairings,
      byPane: () => undefined,
      add: (pairing: Pairing) => pairings.push(pairing),
    } as unknown as PairingStore;
    const replies: string[] = [];
    const picker: unknown[] = [];
    const uploads: string[] = [];
    const notifier: Notifier = {
      async postReply(_channel, _thread, message) { replies.push(message); },
      async postMessage(_channel, _thread, _message, blocks) {
        picker.push(...(blocks ?? []));
        return { async update() {} };
      },
      async uploadFile(_channel, _thread, file) { uploads.push(file.filename); },
    };
    const engine = new TurnEngine(terminals, notifier, {
      turnTimeoutMs: 1000, pollIntervalMs: 10, limits: { maxFileBytes: 1024, maxFileCount: 1 },
    }, store);
    const commands = new CommandHandler(terminals, store, engine, notifier, "owner", ["herdr", "orca", "herdr-core"]);
    const mention = { channel: "channel", threadTs: "1.1", userId: "owner", ts: "1.2" };
    await commands.handleMention({ ...mention, text: "list" });
    assert.match(replies.at(-1) ?? "", /\/sample/);
    assert.doesNotMatch(replies.at(-1) ?? "", /不完全|herdr-core/);
    await commands.handleMention({ ...mention, text: "connect" });
    assert.ok(JSON.stringify(picker).includes(orcaAgent.ref.target));
    await commands.handlePairSelect({ ...mention, terminalId: orcaAgent.ref.target });
    const pairing = pairings[0];
    assert.equal(pairing?.paneId, orcaAgent.ref.target);

    const cwd = join(fake.sessionsDir, "sample");
    const outbox = join(cwd, ".cctag", "outbox");
    mkdirSync(outbox, { recursive: true });
    writeFileSync(join(outbox, "sample.txt"), "sample");
    await engine.uploadOutboxAdditions(pairing, cwd, {}, []);
    assert.deepEqual(uploads, ["sample.txt"]);
    pairings.push({ ...pairing, key: "other", paneId: "hc:t1" });
    await engine.uploadOutboxAdditions(pairing, cwd, {}, []);
    assert.deepEqual(uploads, ["sample.txt"]);
    assert.match(replies.at(-1) ?? "", /herdr-coreのインスタンス一覧/);
    assert.deepEqual(fake.calls(), []);

    await fake.startCore();
    assert.equal((await terminals.list()).agents.at(-1)?.ref.target, "hc:t1");
    const brokenCore = new HcBackend(join(fake.sessionsDir, "missing-hc"), { socket: fake.socket });
    const incomplete = await createTerminals({ herdr: mock(herdrAgent), orca: null, "herdr-core": brokenCore }).list();
    assert.equal(incomplete.complete, false);
    assert.equal(incomplete.failures[0]?.backend, "herdr-core");
  } finally {
    await fake.cleanup();
  }
});
