import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeDriver } from "../agents/claude/driver.js";
import { stripSidePane } from "./side-pane.js";
import { HcBackend, HC_TYPED_TEXT_UNSUPPORTED, HC_UNSUPPORTED_AGENTS_NOTICE } from "./herdr-core.js";
import type { SubmitContext } from "./index.js";
import type { VerifiedPrompt } from "./prompt.js";
import { BackendUnavailable, ExpectationLost, SubmitRefused, WriteOutcomeUnknown, type AgentRef } from "./types.js";

const FIXTURES = new URL("../agents/claude/__fixtures__/", import.meta.url);
const QUESTION_SCREEN = JSON.parse(readFileSync(new URL("hc-question.screen.json", FIXTURES), "utf8")) as { text: string };
const PLAN_SCREEN = JSON.parse(readFileSync(new URL("hc-plan-approval.screen.json", FIXTURES), "utf8")) as { text: string };

interface FakeTerminal {
  address: string;
  agent?: string;
  state?: string;
  status?: string | null;
  pid?: number;
  name?: string | null;
  title?: string;
}

interface Fake {
  bin: string;
  socket: string;
  sessionsDir: string;
  calls(): { args: string[]; env: Record<string, string | undefined> }[];
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
  options: { screens?: string[]; send?: Record<string, unknown> | { error: { kind: string; message: string } } } = {},
): Fake {
  const dir = mkdtempSync(join(tmpdir(), "cctag-hc-"));
  const bin = join(dir, "hc");
  const callsFile = join(dir, "calls.jsonl");
  const readCount = join(dir, "read-count");
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
const env = { HC_TERMINAL_ID: process.env.HC_TERMINAL_ID, HC_SCOPE: process.env.HC_SCOPE, HC_TERMINAL_SOCKET: process.env.HC_TERMINAL_SOCKET };
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
  const t = find(ops[0]);
  out({
    address: t.address, name: t.name ?? null, cwd: "/created/here", state: t.state ?? "live", title: t.title ?? "",
    foreground: t.pid === undefined ? null : { pid: t.pid, cwd: "/moved/here", name: "claude" },
    status: t.status === undefined ? null : { app: t.agent, state: t.status },
  });
} else if (args[0] === "read") {
  find(ops[0]);
  const n = Number(fs.existsSync(${JSON.stringify(readCount)}) ? fs.readFileSync(${JSON.stringify(readCount)}, "utf8") : "0");
  fs.writeFileSync(${JSON.stringify(readCount)}, String(n + 1));
  out({ text: screens[Math.min(n, screens.length - 1)], complete: true, how: "screen" });
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

function ref(address: string): AgentRef {
  return { target: `hc:${address}`, pid: null, processStartedAt: null };
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
    const result = await backend.list();
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

test("hc runs without the Spoke's own HC_TERMINAL_ID and HC_SCOPE", async () => {
  const saved = { id: process.env.HC_TERMINAL_ID, scope: process.env.HC_SCOPE };
  process.env.HC_TERMINAL_ID = "t99";
  process.env.HC_SCOPE = "scope";
  try {
    await withCore([{ address: "t1", agent: "claude-code", status: "idle", pid: 101 }], {}, async (backend, fake) => {
      await backend.submit(ref("t1"), "hello", CTX);
      const send = fake.calls().find((call) => call.args[0] === "send");
      assert.deepEqual(send?.args, ["send", "--json", "--", "t1", "hello"]);
      assert.deepEqual(send?.env, {}, "no HC_* variable reached hc");
    });
  } finally {
    if (saved.id === undefined) delete process.env.HC_TERMINAL_ID;
    else process.env.HC_TERMINAL_ID = saved.id;
    if (saved.scope === undefined) delete process.env.HC_SCOPE;
    else process.env.HC_SCOPE = saved.scope;
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

test("read asks for history lines only for the history region and strips the side pane", async () => {
  await withCore([{ address: "t1" }], { screens: [QUESTION_SCREEN.text] }, async (backend, fake) => {
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
  await withCore([{ address: "t1" }], { screens: [QUESTION_SCREEN.text] }, async (backend, fake) => {
    const prompt = verified(stripSidePane(QUESTION_SCREEN.text));
    const channel = backend.openAnswer(ref("t1"), prompt);
    await channel.move("Down", 2);
    await channel.digit(1, false);
    await channel.confirm("Amber");
    const writes = fake.calls().filter((call) => call.args[0] !== "read").map((call) => call.args);
    assert.deepEqual(writes, [
      ["keys", "--json", "--", "t1", "down", "down"],
      ["keys", "--json", "--", "t1", "1"],
      ["keys", "--json", "--", "t1", "enter"],
    ]);
    assert.equal(fake.calls().filter((call) => call.args[0] === "read").length, 1);
  });
});

test("typed text is pasted together with its Enter, and nothing else may follow it", async () => {
  await withCore([{ address: "t1" }], { screens: [QUESTION_SCREEN.text] }, async (backend, fake) => {
    const prompt = verified(stripSidePane(QUESTION_SCREEN.text));
    const channel = backend.openAnswer(ref("t1"), prompt);
    await channel.move("Down", 2);
    await channel.text("Cが好き");
    await channel.confirm("Cが好き");
    assert.deepEqual(
      fake.calls().filter((call) => call.args[0] !== "read").map((call) => call.args),
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
  await withCore([{ address: "t1" }], { screens: [PLAN_SCREEN.text] }, async (backend, fake) => {
    const channel = backend.openAnswer(ref("t1"), verified(stripSidePane(QUESTION_SCREEN.text)));
    await assert.rejects(channel.digit(1), ExpectationLost);
    assert.deepEqual(fake.calls().filter((call) => call.args[0] !== "read"), []);
  });
});

test("Shift+Tab and blind y/n answers use hc's key names", async () => {
  await withCore([{ address: "t1" }], {}, async (backend, fake) => {
    await backend.openComposer(ref("t1"), claudeDriver).backTab();
    await backend.openBlind(ref("t1"), { form: "key-then-enter" } as never).answer("y");
    assert.deepEqual(
      fake.calls().map((call) => call.args),
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
  await withCore([{ address: "t1" }], { screens: [PLAN_SCREEN.text] }, async (backend, fake) => {
    const prompt = verified(PLAN_SCREEN.text);
    const channel = backend.openAnswer(ref("t1"), prompt);
    await claudeDriver.answerPlanFeedback!(channel, 3, "改行1つだけにして");
    assert.deepEqual(
      fake.calls().filter((call) => call.args[0] !== "read").map((call) => call.args),
      [
        ["keys", "--json", "--", "t1", "3"],
        ["send", "--force", "--json", "--", "t1", "改行1つだけにして"],
      ],
    );
  });
});
