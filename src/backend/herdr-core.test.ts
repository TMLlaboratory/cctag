import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeDriver } from "../agents/claude/driver.js";
import { submitRefusedText } from "./submit-notice.js";
import { stripSidePane } from "./side-pane.js";
import { HcBackend, HC_TYPED_TEXT_UNSUPPORTED, HC_UNSUPPORTED_AGENTS_NOTICE } from "./herdr-core.js";
import type { SubmitContext } from "./index.js";
import type { VerifiedPrompt } from "./prompt.js";
import { BackendUnavailable, ExpectationLost, SubmitRefused, WriteOutcomeUnknown, type AgentRef } from "./types.js";

const FIXTURES = new URL("../agents/claude/__fixtures__/", import.meta.url);
const QUESTION_SCREEN = JSON.parse(readFileSync(new URL("hc-question.screen.json", FIXTURES), "utf8")) as { text: string };
const PLAN_SCREEN = JSON.parse(readFileSync(new URL("hc-plan-approval.screen.json", FIXTURES), "utf8")) as { text: string };
const PAINTS = JSON.parse(readFileSync(new URL("hc-composer.ansi.json", FIXTURES), "utf8")) as Record<string, string>;
const EMPTY = PAINTS["review-empty"]!;
const EMPTY_PROBE = PAINTS["review-empty-probed"]!;
const EMPTY_SEND = [EMPTY, EMPTY, EMPTY_PROBE, EMPTY_PROBE, EMPTY, EMPTY];
const STASHED = PAINTS["review-stashed"]!;
const STASH_PROBE = PAINTS["review-stashed-probed"]!;
const STASH_SEND = [STASHED, STASH_PROBE, STASH_PROBE, STASHED, STASHED];
const SUBMIT_TERMINAL = { address: "t1", agent: "claude-code", status: "idle", pid: 101 };

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
  options: {
    screens?: string[];
    paints?: string[];
    changedAt?: number;
    legacySession?: boolean;
    send?: Record<string, unknown> | { error: { kind: string; message: string } };
  } = {},
): Fake {
  const dir = mkdtempSync(join(tmpdir(), "cctag-hc-"));
  const bin = join(dir, "hc");
  const callsFile = join(dir, "calls.jsonl");
  const readCount = join(dir, "read-count");
  const sessionsDir = join(dir, "sessions");
  mkdirSync(sessionsDir);
  for (const t of terminals) {
    if (t.pid !== undefined) {
      writeFileSync(join(sessionsDir, `${t.pid}.json`), JSON.stringify({ sessionId: `session-${t.pid}`, cwd: `/repo/${t.address}`, ...(options.legacySession ? {} : { pid: t.pid, startedAt: 1234 }) }));
    }
  }
  const script = `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const ops = args.includes("--") ? args.slice(args.indexOf("--") + 1) : [];
const env = { HC_TERMINAL_ID: process.env.HC_TERMINAL_ID, HC_SCOPE: process.env.HC_SCOPE, HC_TERMINAL_SOCKET: process.env.HC_TERMINAL_SOCKET, HC_SOCKET: process.env.HC_SOCKET, HC_SESSION: process.env.HC_SESSION };
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
  let observation = 0;
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
        server = createServer((socket) => {
          socket.once("data", (hello) => {
            assert.equal(JSON.parse(hello.toString()).method, "hello");
            socket.write(JSON.stringify({ id: 0, result: { framed: true } }) + "\n");
            socket.once("data", (bytes) => {
              const request = JSON.parse(bytes.subarray(9).toString());
              assert.equal(request.method, "terminal.attach");
              assert.equal(request.params.observe, true);
              assert.equal(request.params.history, 0);
              const terminal = terminals.find((t) => t.address === request.params.terminal);
              assert.ok(terminal);
              const index = observation++;
              const paint = options.paints ? options.paints[Math.min(index, options.paints.length - 1)]! : EMPTY_SEND[index % EMPTY_SEND.length]!;
              const frame = (channel: number, value: string) => {
                const payload = Buffer.from(value);
                const header = Buffer.alloc(9);
                header.writeUInt32LE(channel);
                header.writeUInt32LE(payload.length, 5);
                return Buffer.concat([header, payload]);
              };
              if (observation === options.changedAt) {
                const path = join(sessionsDir, `${terminal.pid}.json`);
                const old = JSON.parse(readFileSync(path, "utf8"));
                writeFileSync(path, JSON.stringify({ ...old, startedAt: old.startedAt + 1 }));
              }
              socket.write(Buffer.concat([frame(0, JSON.stringify({ id: 1, result: {
                channel: 1,
                terminal: {
                  address: terminal.address, state: "live", cols: 200, screen: "exact",
                  foreground: { pid: terminal.pid, name: "claude" },
                  status: { app: terminal.agent, state: terminal.status },
                },
              } })), frame(1, paint)]));
            });
          });
        });
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

async function submitRef(backend: HcBackend): Promise<AgentRef> {
  const agent = await backend.get("hc:t1");
  assert.ok(agent);
  return agent.ref;
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

test("old Claude session files still support list and pairing lookup, while writes require native identity", async () => {
  await withCore([SUBMIT_TERMINAL], { legacySession: true }, async (backend, fake) => {
    const [listed] = (await backend.list()).agents;
    assert.equal(listed?.sessionId, "session-101");
    const agent = await backend.get("hc:t1");
    assert.equal(agent?.cwd, "/repo/t1");
    assert.equal(agent.ref.processStartedAt, null);
    await assert.rejects(backend.submit(agent.ref, "go", CTX), (error) => {
      assert.ok(error instanceof SubmitRefused);
      assert.equal(error.reason, "agent-unverified");
      assert.match(submitRefusedText(error.reason, "herdr-core"), /プロセス情報が不足.*端末から入力/u);
      return true;
    });
    assert.deepEqual(writes(fake), []);
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
  const saved = { ...process.env };
  process.env.HC_SOCKET = "/tmp/another-core.sock";
  process.env.HC_SESSION = "other-session";
  process.env.HC_TERMINAL_ID = "t99";
  process.env.HC_SCOPE = "scope";
  try {
    await withCore([{ address: "t1", agent: "claude-code", status: "idle", pid: 101 }], {}, async (backend, fake) => {
      await backend.submit(await submitRef(backend), "hello", CTX);
      const send = fake.calls().find((call) => call.args[0] === "send");
      assert.deepEqual(send?.args, ["send", "--json", "--", "t1", "hello"]);
      assert.ok(fake.calls().every(({ env }) => Object.keys(env).length === 1 && env.HC_SOCKET === fake.socket));
    });
  } finally {
    for (const name of ["HC_TERMINAL_ID", "HC_SCOPE", "HC_SOCKET", "HC_SESSION"]) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});

test("a message that starts with a hyphen is sent as text, not read as a flag", async () => {
  await withCore([SUBMIT_TERMINAL], {}, async (backend, fake) => {
    const agent = await submitRef(backend);
    await backend.submit(agent, "--force", CTX);
    await backend.submit(agent, "-1 for that", CTX);
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
  await withCore([SUBMIT_TERMINAL], { send: { started: true, status: "working", turn: 2 } }, async (backend) => {
    assert.deepEqual(await backend.submit(await submitRef(backend), "go", CTX), { status: "started", draftStashed: false });
  });
  await withCore([SUBMIT_TERMINAL], { send: { started: false, status: "idle", turn: 1 } }, async (backend) => {
    assert.deepEqual(await backend.submit(await submitRef(backend), "/model", CTX), { status: "accepted", draftStashed: false });
  });
});

test("submit turns hc's refusal of a blocked terminal into a gate refusal, and other failures into an unknown outcome", async () => {
  await withCore([SUBMIT_TERMINAL], { send: { error: { kind: "blocked", message: "t1 is blocked (permission)" } } }, async (backend) => {
    await assert.rejects(backend.submit(await submitRef(backend), "go", CTX), (err: unknown) => err instanceof SubmitRefused && err.reason === "gate");
  });
  await withCore([SUBMIT_TERMINAL], { send: { error: { kind: "unavailable", message: "the core is stopping" } } }, async (backend) => {
    await assert.rejects(backend.submit(await submitRef(backend), "go", CTX), WriteOutcomeUnknown);
  });
});

const STASH_PAINTS = [
  PAINTS["caret-middle"]!, PAINTS["caret-middle"]!, PAINTS["mid-probe"]!, PAINTS["mid-probe"]!,
  PAINTS["caret-middle"]!, PAINTS["caret-middle"]!, STASHED,
];

function writes(fake: Fake): string[][] {
  return fake.calls().filter(({ args }) => ["send", "keys"].includes(args[0]!)).map(({ args }) => args);
}

test("core replaces a restored suggestion only if its style still matches before send", async () => {
  const initial = PAINTS.suggestion!;
  const probe = PAINTS["suggestion-x"]!;
  const reversed = PAINTS["suggestion-backspace"]!;
  const withoutDim = reversed.replace("\x1b[2mnce fixed", "nce fixed");
  assert.notEqual(withoutDim, reversed);
  for (const final of [reversed, withoutDim]) {
    await withCore([SUBMIT_TERMINAL], {
      paints: [initial, initial, probe, probe, reversed, final],
    }, async (backend, fake) => {
      const submit = backend.submit(await submitRef(backend), "go", CTX);
      const keys = [["keys", "--json", "--", "t1", "x"], ["keys", "--json", "--", "t1", "backspace"]];
      if (final === reversed) {
        assert.deepEqual(await submit, { status: "started", draftStashed: false });
        assert.deepEqual(writes(fake), [...keys, ["send", "--json", "--", "t1", "go"]]);
      } else {
        await assert.rejects(submit, (error) => error instanceof SubmitRefused && error.reason === "draft");
        assert.deepEqual(writes(fake), keys);
      }
    });
  }
});

test("core rechecks a middle caret, stashes and sends once without claiming exact restoration", async () => {
  const preStash = STASH_PAINTS.slice(0, -1);
  await withCore([SUBMIT_TERMINAL], {
    paints: [...preStash, PAINTS["caret-middle"]!, STASHED, ...STASH_SEND, PAINTS["review-trailing"]!],
  }, async (backend, fake) => {
    assert.deepEqual(await backend.submit(await submitRef(backend), "go", CTX), {
      status: "started", draftStashed: true, draftRestoration: "unverified",
    });
    assert.deepEqual(writes(fake), [
      ["keys", "--json", "--", "t1", "x"],
      ["keys", "--json", "--", "t1", "backspace"],
      ["keys", "--json", "--", "t1", "ctrl+s"],
      ["keys", "--json", "--", "t1", "right", "x"],
      ["keys", "--json", "--", "t1", "backspace"],
      ["send", "--json", "--", "t1", "go"],
    ]);
  });
});

test("core refuses an intervening draft or changed foreground instance before send", async () => {
  for (const [competing, changedAt, reason] of [
    [PAINTS.competing!, undefined, "stash-unverified"],
    [PAINTS.stashed!, 8, "agent-changed"],
  ] as const) {
    await withCore([SUBMIT_TERMINAL], { paints: [...STASH_PAINTS, competing], changedAt }, async (backend, fake) => {
      await assert.rejects(backend.submit(await submitRef(backend), "go", CTX),
        (error) => error instanceof SubmitRefused && error.reason === reason && error.composer.stash === "stashed");
      assert.deepEqual(writes(fake).map((args) => args.at(-1)), ["x", "backspace", "ctrl+s"]);
    });
  }
});

test("a caret-zero competing draft on the first post-stash read receives no further key", async () => {
  await withCore([SUBMIT_TERMINAL], { paints: [...STASH_PAINTS.slice(0, -1), PAINTS["review-first-competing"]!] }, async (backend, fake) => {
    await assert.rejects(backend.submit(await submitRef(backend), "go", CTX),
      (error) => error instanceof SubmitRefused && error.reason === "stash-unverified" && error.composer.stash === "stashed");
    assert.deepEqual(writes(fake).map((args) => args.at(-1)), ["x", "backspace", "ctrl+s"]);
  });
});

test("the original draft text with a stash marker refuses before a later empty paint", async () => {
  const sameText = PAINTS["review-first-competing"]!.replace("z\x1b[0m", "d\x1b[0mraft");
  await withCore([SUBMIT_TERMINAL], {
    paints: [...STASH_PAINTS.slice(0, -1), sameText, STASHED, ...STASH_SEND],
  }, async (backend, fake) => {
    await assert.rejects(backend.submit(await submitRef(backend), "go", CTX),
      (error) => error instanceof SubmitRefused && error.reason === "stash-unverified" && error.composer.stash === "stashed");
    assert.deepEqual(writes(fake).map((args) => args.slice(4)), [["x"], ["backspace"], ["ctrl+s"]]);
  });
});

test("core refuses a trailing space exposed by the final probe and reverses its keys", async () => {
  const hidden = PAINTS["review-stashed-hidden-probed"]!;
  await withCore([SUBMIT_TERMINAL], { paints: [...STASH_PAINTS, STASHED, hidden, hidden, STASHED] }, async (backend, fake) => {
    await assert.rejects(backend.submit(await submitRef(backend), "go", CTX),
      (error) => error instanceof SubmitRefused && error.reason === "stash-unverified" && error.composer.probe === null);
    assert.deepEqual(writes(fake).map((args) => args.slice(4)), [
      ["x"], ["backspace"], ["ctrl+s"], ["right", "x"], ["backspace", "left"],
    ]);
  });
});

test("core refuses a partial paint, whitespace-only draft, existing stash, model draft or image draft without input", async () => {
  for (const [paint, text, hasImages, reason] of [
    [PAINTS.empty!.slice(0, -8), "go", false, "incomplete-screen"],
    [PAINTS.space!, "go", false, "incomplete-screen"],
    [PAINTS.stashed!, "go", false, "existing-stash"],
    [PAINTS["caret-end"]!, "/model haiku", false, "draft"],
    [PAINTS["caret-end"]!, "go", true, "draft"],
  ] as const) {
    await withCore([SUBMIT_TERMINAL], { paints: [paint] }, async (backend, fake) => {
      await assert.rejects(backend.submit(await submitRef(backend), text, { ...CTX, hasImages }),
        (error) => error instanceof SubmitRefused && error.reason === reason);
      assert.deepEqual(writes(fake), []);
    });
  }
});

test("core preserves accepted and unknown delivery outcomes independently of restoration", async () => {
  await withCore([SUBMIT_TERMINAL], {
    paints: [...STASH_PAINTS, ...STASH_SEND], send: { started: false },
  }, async (backend, fake) => {
    assert.deepEqual(await backend.submit(await submitRef(backend), "go", CTX), {
      status: "accepted", draftStashed: true, draftRestoration: "unverified",
    });
    assert.deepEqual(writes(fake).map((args) => args.at(-1)), ["x", "backspace", "ctrl+s", "x", "backspace", "go"]);
  });
  await withCore([SUBMIT_TERMINAL], {
    paints: [...STASH_PAINTS, ...STASH_SEND, PAINTS["review-trailing"]!],
    send: { error: { kind: "unavailable", message: "transport lost" } },
  }, async (backend, fake) => {
    await assert.rejects(backend.submit(await submitRef(backend), "go", CTX),
      (error) => error instanceof WriteOutcomeUnknown && error.composer.submitUncertain === true && error.composer.draftRestored === false);
    assert.deepEqual(writes(fake).map((args) => args.at(-1)), ["x", "backspace", "ctrl+s", "x", "backspace", "go"]);
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
