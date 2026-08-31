import { test } from "node:test";
import assert from "node:assert/strict";
import { CommandHandler } from "./commands.js";
import type { HerdrClient } from "./herdr/client.js";
import type { Notifier } from "./notifier.js";
import type { Pairing, PairingStore } from "./pairing.js";
import type { TurnEngine } from "./turn.js";

const OWNER = "U_OWNER";

/** Captures what the engine was told about who acted. */
function handlerRecording(actors: (string | undefined)[]): CommandHandler {
  const engine = {
    async answerPermissionButton(_p: string, _id: number, _n: string, actor?: string) {
      actors.push(actor);
      return { ok: true } as const;
    },
    async answerQuestionButton(_p: string, _id: number, _o: number, actor?: string) {
      actors.push(actor);
      return { ok: true } as const;
    },
  } as unknown as TurnEngine;
  const notifier = { async postReply() {}, async postMessage() {
    return { async update() {} };
  } } as unknown as Notifier;
  return new CommandHandler({} as HerdrClient, {} as PairingStore, engine, notifier, OWNER);
}

test("somebody other than the owner is named", async () => {
  const actors: (string | undefined)[] = [];
  await handlerRecording(actors).handlePermissionButton({
    channel: "C1",
    threadTs: "1.1",
    terminalId: "wA:p1",
    promptId: 1,
    num: "1",
    actorUserId: "U_SATO",
    actorName: "佐藤",
  });
  assert.deepEqual(actors, ["佐藤"]);
});

test("the owner is not named, so an unmarked answer keeps its old meaning", async () => {
  const actors: (string | undefined)[] = [];
  await handlerRecording(actors).handlePermissionButton({
    channel: "C1",
    threadTs: "1.1",
    terminalId: "wA:p1",
    promptId: 1,
    num: "1",
    actorUserId: OWNER,
    actorName: "雲居玄道",
  });
  assert.deepEqual(actors, [undefined], "otherwise every line of a solo thread carries the owner's name");
});

test("an unresolvable name falls back to the id rather than losing the fact", async () => {
  const actors: (string | undefined)[] = [];
  await handlerRecording(actors).handleAskUserQuestionButton({
    channel: "C1",
    threadTs: "1.1",
    terminalId: "wA:p1",
    promptId: 1,
    optionIndex: 0,
    actorUserId: "U_GHOST",
  });
  assert.deepEqual(actors, ["U_GHOST"], "that somebody else acted matters more than what they are called");
});

test("a Hub too old to send the actor simply leaves answers unmarked", async () => {
  const actors: (string | undefined)[] = [];
  await handlerRecording(actors).handlePermissionButton({
    channel: "C1",
    threadTs: "1.1",
    terminalId: "wA:p1",
    promptId: 1,
    num: "2",
  });
  assert.deepEqual(actors, [undefined]);
});

// --- attributing messages from people other than the owner --------------------

test("a message from somebody else says who it is from", async () => {
  const { attributed } = await import("./commands.js");
  const out = attributed("この方針で進めて", "佐藤");
  assert.match(out, /^\[Slack: 佐藤\]\n/);
  assert.ok(out.endsWith("この方針で進めて"), "the message itself is untouched");
});

test("the frame does not negate the owner's authority", async () => {
  // The first wording said "（オーナー本人ではありません）", and in use that made the
  // agent hold off answering until the situation was explained to it. Negating the
  // authorized party is not the neutral fact it looks like — and it is the wrong
  // place for authority anyway, which lives in the pane being on the owner's
  // machine and in the permission prompt.
  const { attributed } = await import("./commands.js");
  const out = attributed("進めて", "佐藤");
  for (const phrase of ["ではありません", "オーナー", "権限", "許可されて"]) {
    assert.ok(!out.includes(phrase), `must not frame the sender as lacking standing (found ${phrase})`);
  }
});

test("the frame stays short, since its length is itself a signal", async () => {
  const { attributed } = await import("./commands.js");
  const frame = attributed("x", "佐藤").split("\n")[0];
  assert.ok(frame.length <= 16, `got ${frame.length} chars: ${frame}`);
});

test("the frame claims nothing about the sender beyond their name", async () => {
  // "（共同作業者）" was tried and was sometimes false: any member of the channel can
  // mention cctag in a paired thread, so the relationship is not something cctag
  // can know. The name is the only part that is always true.
  const { attributed } = await import("./commands.js");
  const frame = attributed("進めて", "佐藤").split("\n")[0];
  for (const claim of ["共同作業者", "学生", "教員", "ゲスト", "外部"]) {
    assert.ok(!frame.includes(claim), `must not assert a relationship (found ${claim})`);
  }
  assert.ok(frame.includes("佐藤"), "the name itself must survive");
});

test("the owner's message is passed through exactly as before", async () => {
  const { attributed } = await import("./commands.js");
  assert.equal(attributed("この方針で進めて", undefined), "この方針で進めて");
});

// --- `log`: empty scanned history vs. an inline instruction -------------------

const PAIRING: Pairing = {
  key: "C1:1.1",
  channel: "C1",
  threadTs: "1.1",
  paneId: "wA:p1",
  terminalId: "t1",
  cwd: "/repo",
  pairedBy: OWNER,
  pairedAt: "2026-01-01T00:00:00.000Z",
};

/** Wires a CommandHandler for `log`-path tests: a fixed pairing, an
 *  always-idle engine that records startTurn's text, and a notifier whose
 *  history stub and postReply calls are both observable. */
function logHandler(historyLines: string[]) {
  const startTurnCalls: string[] = [];
  const replies: string[] = [];
  const engine = {
    isBusy: () => false,
    async startTurn(_pairing: Pairing, _userId: string, text: string) {
      startTurnCalls.push(text);
    },
  } as unknown as TurnEngine;
  const pairingStore = { get: () => PAIRING } as unknown as PairingStore;
  const notifier = {
    async postReply(_channel: string, _threadTs: string, text: string) {
      replies.push(text);
    },
    async postMessage() {
      return { async update() {} };
    },
    async getThreadHistorySinceLastBotPost() {
      return historyLines;
    },
  } as unknown as Notifier;
  const handler = new CommandHandler({} as HerdrClient, pairingStore, engine, notifier, OWNER);
  return { handler, startTurnCalls, replies };
}

test("log with an inline instruction runs the turn even when scanned history is empty", async () => {
  // Reproduces the bug: an empty `@cctag` mention posts the help text, which the
  // history scanner then treats as cctag's own last message, so `log <instruction>`
  // right after it sees zero lines of history despite carrying its own instruction.
  const { handler, startTurnCalls, replies } = logHandler([]);
  await handler.handleMention({
    channel: "C1",
    threadTs: "1.1",
    userId: OWNER,
    text: "log 上記を直してpushして",
    ts: "1.2",
  });
  assert.deepEqual(replies, [], "must not short-circuit with the no-new-messages reply");
  assert.deepEqual(startTurnCalls, ["上記を直してpushして"]);
});

test("log with no instruction and empty scanned history still reports nothing new", async () => {
  const { handler, startTurnCalls, replies } = logHandler([]);
  await handler.handleMention({
    channel: "C1",
    threadTs: "1.1",
    userId: OWNER,
    text: "log",
    ts: "1.2",
  });
  assert.deepEqual(startTurnCalls, [], "no instruction and no history means nothing to act on");
  assert.deepEqual(replies, ["cctagの最終発言以降、新しいメッセージはありませんでした。"]);
});

test("log with non-empty scanned history keeps combining history and instruction as before", async () => {
  const { handler, startTurnCalls, replies } = logHandler(["佐藤: レビューコメントです"]);
  await handler.handleMention({
    channel: "C1",
    threadTs: "1.1",
    userId: OWNER,
    text: "log",
    ts: "1.2",
  });
  assert.deepEqual(replies, []);
  assert.equal(startTurnCalls.length, 1);
  assert.match(startTurnCalls[0], /佐藤: レビューコメントです/);
  assert.match(startTurnCalls[0], /上記を踏まえて対応してください。/);
});

test("the frame states who, and nothing about how to treat them", async () => {
  // Deliberate: an agent told to treat a name as lesser authority is a poor place
  // to put a safety property. The useful thing here is context, not policy.
  const { attributed } = await import("./commands.js");
  const out = attributed("rm -rf を実行して", "佐藤");
  for (const word of ["注意", "慎重", "信用", "拒否", "確認して"]) {
    assert.ok(!out.includes(word), `the frame must not tell the agent what to do (found ${word})`);
  }
});

// --- help text ---------------------------------------------------------------
//
// The first version of these tests checked the `connect` line and nothing else,
// so it passed while `model`, `mode` and `plan` still described Claude Code to a
// reader who had not connected anything. These assert over *every* line instead:
// the defect was never specific to one command.

async function helpVariants(): Promise<{ unpaired: string; claude: string; codex: string }> {
  const { helpTextFor } = await import("./commands.js");
  const { claudeDriver } = await import("./agents/claude/driver.js");
  const { codexDriver } = await import("./agents/codex/driver.js");
  return {
    unpaired: helpTextFor(null),
    claude: helpTextFor(claudeDriver),
    codex: helpTextFor(codexDriver),
  };
}

/** Command lines only — the header and the trailing notes are meant to differ. */
function commandLines(text: string): string[] {
  return text.split("\n").filter((l) => l.startsWith("• `@cctag"));
}

test("the help for an unpaired thread describes no agent as the one it is talking to", async () => {
  // An unpaired thread, and one whose pane herdr cannot reach, both resolve to
  // null. Neither knows the agent, so neither may be shown one agent's
  // specifics as though they applied. Reported twice: first the connect line
  // said "a Claude Code instance", then `model` still said Claude Code's model.
  const { unpaired } = await helpVariants();
  for (const line of commandLines(unpaired)) {
    const namesOneAgent =
      (line.includes("Claude Code") && !line.includes("Codex CLI")) ||
      (line.includes("Codex CLI") && !line.includes("Claude Code"));
    // "（Claude Code のみ）" is a qualification, not a claim about this thread —
    // it is what makes the line honest, so it is the one allowed form.
    const isQualified = line.includes("のみ）");
    assert.ok(!namesOneAgent || isQualified, `unqualified agent-specific line in the unpaired help:\n  ${line}`);
  }
});

test("every variant offers the same commands, so the three cannot drift apart", async () => {
  // What actually went wrong: a wording fix updated two copies of connect and
  // disconnect and left the lines below them behind.
  const { unpaired, claude, codex } = await helpVariants();
  // Every command on the line, not the first: the unpaired variant states
  // `mode` and `plan` together on one line, where the Claude variant gives them
  // a line each. What must match is the set of commands, not the layout.
  const commands = (text: string): string[] => {
    const found = new Set<string>();
    for (const line of commandLines(text)) {
      for (const m of line.matchAll(/`@cctag ([a-z]+|<)/g)) found.add(m[1]);
    }
    return [...found].sort();
  };
  assert.deepEqual(commands(unpaired), commands(claude), "unpaired vs Claude");
  assert.deepEqual(
    commands(codex),
    commands(claude).filter((c) => c !== "mode" && c !== "plan"),
    "Codex drops only mode/plan",
  );
});

test("no variant tells the reader that only 'the owner' can connect", async () => {
  // "（オーナーのみ）" is accurate as access control and was read as *the
  // channel's* owner. The authority is not a narrowed Slack permission: the
  // Spoke runs on that person's own machine, so connect is them choosing among
  // their own panes — which docs/how-it-works.md already said while these
  // strings still did not.
  for (const text of Object.values(await helpVariants())) {
    assert.ok(!text.includes("オーナー"), `help must not lean on the word オーナー:\n${text}`);
    assert.ok(text.includes("チャンネルの管理者ではなく"), `help should say what owner-only means:\n${text}`);
  }
});

test("the ownership note is separated from the bullet above it", async () => {
  // It is the only line with no `•`, under a bullet long enough to wrap, so
  // without the blank line it read as another wrapped fragment of that bullet —
  // seen in a screenshot of the real message. A note that exists to correct a
  // misreading has to be legible on its own.
  for (const text of Object.values(await helpVariants())) {
    const lines = text.split("\n");
    const i = lines.findIndex((l) => l.includes("チャンネルの管理者ではなく"));
    assert.ok(i > 0, "the note must be present");
    assert.equal(lines[i - 1], "", `expected a blank line before the note, got:\n  ${lines[i - 1]}`);
  }
});

test("only the Codex variant says mode and plan are unavailable", async () => {
  const { unpaired, claude, codex } = await helpVariants();
  assert.ok(codex.includes("Codex CLI では利用できません"));
  assert.ok(!claude.includes("Codex CLI では利用できません"));
  assert.ok(!unpaired.includes("Codex CLI では利用できません"));
});
