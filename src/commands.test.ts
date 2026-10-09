import { randomInt } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { CommandHandler } from "./commands.js";
import type { Terminals } from "./backend/index.js";
import type { Notifier } from "./notifier.js";
import type { Pairing, PairingStore } from "./pairing.js";
import type { TurnEngine } from "./turn.js";
import {
  ExpectationLost,
  SubmitRefused,
  WriteOutcomeUnknown,
  type AgentInfo,
} from "./backend/types.js";

const NO_TERMINALS = {} as Terminals;
const OWNER = "U_OWNER";

const BUTTON_PAIRING: Pairing = {
  key: "C1:1.1",
  channel: "C1",
  threadTs: "1.1",
  paneId: "wA:p1",
  terminalId: "term_test",
  cwd: "/tmp",
  pairedBy: OWNER,
  pairedAt: "2026-01-01T00:00:00.000Z",
};

test("connect stores Herdr's raw terminal_id, not the pane or picker name", async () => {
  const stored: Pairing[] = [];
  const agent: AgentInfo = {
    ref: { target: "pane-id", pid: null, processStartedAt: null },
    backend: "herdr",
    agent: "claude",
    sessionId: null,
    cwd: "/tmp/project",
    evidence: { kind: "classified", status: "idle" },
    terminalTitle: null,
    terminalId: "herdr-terminal-id",
    displayId: "picker-name",
  };
  const terminals = {
    async get(target: string) {
      assert.equal(target, "pane-id");
      return agent;
    },
  } as unknown as Terminals;
  const pairingStore = {
    byPane() {
      return undefined;
    },
    add(pairing: Pairing) {
      stored.push(pairing);
    },
  } as unknown as PairingStore;
  const replies: string[] = [];
  const notifier = {
    async postReply(_channel: string, _threadTs: string, text: string) {
      replies.push(text);
    },
  } as unknown as Notifier;
  const handler = new CommandHandler(terminals, pairingStore, {} as TurnEngine, notifier, OWNER);

  await handler.handlePairSelect({
    channel: "C1",
    threadTs: "1.1",
    userId: OWNER,
    terminalId: "pane-id",
  });

  assert.equal(stored.length, 1);
  assert.equal(stored[0].paneId, "pane-id");
  assert.equal(stored[0].terminalId, "herdr-terminal-id");
});

test("connect stores Orca's namespaced target and backend without its PID", async () => {
  const stored: Pairing[] = [];
  const target = "orca:tab-7:leaf-2";
  const agent: AgentInfo = {
    ref: { target, pid: 420, processStartedAt: 123 },
    backend: "orca",
    agent: "codex",
    sessionId: null,
    cwd: "/tmp/orca-project",
    evidence: { kind: "hint", state: null, waitingSince: null },
    terminalTitle: null,
    terminalId: "orca-tab-7",
    displayId: target,
  };
  const terminals = {
    async get(received: string) {
      assert.equal(received, target);
      return agent;
    },
  } as unknown as Terminals;
  const pairingStore = {
    byPane() {
      return undefined;
    },
    add(pairing: Pairing) {
      stored.push(pairing);
    },
  } as unknown as PairingStore;
  const notifier = {
    async postReply() {},
  } as unknown as Notifier;
  const handler = new CommandHandler(terminals, pairingStore, {} as TurnEngine, notifier, OWNER);

  await handler.handlePairSelect({
    channel: "C1",
    threadTs: "1.1",
    userId: OWNER,
    terminalId: target,
  });

  assert.equal(stored.length, 1);
  assert.equal(stored[0].paneId, target);
  assert.equal(stored[0].backend, "orca");
  assert.equal("pid" in stored[0], false);
});

test("connect's empty picker lists enabled backends and Orca diagnostics", async () => {
  const result = {
    agents: [],
    failures: [{ backend: "herdr" as const, reason: "CLI unavailable" }],
    complete: false,
    notices: [
      "Orca 上の Codex は未対応です",
      "orca:tab-7:leaf-2: セッションを特定できないため接続できません",
    ],
  };
  const terminals = { async list() { return result; } } as unknown as Terminals;
  let postedBlocks: unknown[] = [];
  const notifier = {
    async postMessage(_channel: string, _threadTs: string, _text: string, blocks: unknown[]) {
      postedBlocks = blocks;
      return { async update() {} };
    },
  } as unknown as Notifier;
  const handler = new CommandHandler(
    terminals,
    {} as PairingStore,
    {} as TurnEngine,
    notifier,
    OWNER,
    ["herdr", "orca"],
  );

  await handler.handleMention({
    channel: "C1",
    threadTs: "1.1",
    userId: OWNER,
    text: "connect",
    ts: "1.2",
  });

  const text = JSON.stringify(postedBlocks);
  assert.match(text, /現在 herdr \/ orca 上/);
  assert.match(text, /CLI unavailable/);
  assert.match(text, /Orca 上の Codex は未対応です/);
  assert.match(text, /セッションを特定できないため接続できません/);
});

/** Posts a simulated permission button and reads back its prompt ID as Slack does. */
async function postedButtonPromptId(): Promise<number> {
  const promptId = randomInt(1, 2 ** 48);
  let postedBlocks: unknown[] = [];
  const notifier: Notifier = {
    async postReply() {},
    async postMessage(_channel, _threadTs, _text, blocks) {
      postedBlocks = blocks ?? [];
      return { async update() {} };
    },
  };
  await notifier.postMessage("C1", "1.1", "permission prompt", [
    {
      type: "actions",
      elements: [{ type: "button", value: JSON.stringify({ k: "perm", t: "wA:p1", p: promptId, n: "1" }) }],
    },
  ]);

  for (const block of postedBlocks) {
    if (block === null || typeof block !== "object" || !("elements" in block) || !Array.isArray(block.elements)) {
      continue;
    }
    for (const element of block.elements) {
      if (element === null || typeof element !== "object" || !("value" in element) || typeof element.value !== "string") {
        continue;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(element.value);
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
  }
  throw new Error("fake notifier did not capture a permission button ID");
}

/** Captures actor labels and the resolved pairing keys sent to TurnEngine. */
function handlerRecording(
  actors: (string | undefined)[],
  pairingKeys: (string | undefined)[] = [],
  pairing: Pairing = BUTTON_PAIRING,
): CommandHandler {
  const engine = {
    async answerPermissionButton(_p: string, _id: number, _n: string, pairingKey: string | undefined, actor?: string) {
      pairingKeys.push(pairingKey);
      actors.push(actor);
      return { ok: true } as const;
    },
    async answerQuestionButton(_p: string, _id: number, _o: number, pairingKey: string | undefined, actor?: string) {
      pairingKeys.push(pairingKey);
      actors.push(actor);
      return { ok: true } as const;
    },
  } as unknown as TurnEngine;
  const pairingStore = {
    get(channel: string, threadTs?: string) {
      if (pairing.channel !== channel) return undefined;
      if (pairing.threadTs && pairing.threadTs !== threadTs) return undefined;
      return pairing;
    },
  } as unknown as PairingStore;
  const notifier = { async postReply() {}, async postMessage() {
    return { async update() {} };
  } } as unknown as Notifier;
  return new CommandHandler(NO_TERMINALS, pairingStore, engine, notifier, OWNER);
}

test("somebody other than the owner is named", async () => {
  const actors: (string | undefined)[] = [];
  await handlerRecording(actors).handlePermissionButton({
    channel: "C1",
    threadTs: "1.1",
    terminalId: "wA:p1",
    promptId: await postedButtonPromptId(),
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
    promptId: await postedButtonPromptId(),
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
    promptId: await postedButtonPromptId(),
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
    promptId: await postedButtonPromptId(),
    num: "2",
  });
  assert.deepEqual(actors, [undefined]);
});

test("a button in a channel resolves its channel-level pairing key", async () => {
  const pairingKeys: (string | undefined)[] = [];
  const channelPairing: Pairing = { ...BUTTON_PAIRING, key: "C1", threadTs: undefined };
  await handlerRecording([], pairingKeys, channelPairing).handlePermissionButton({
    channel: "C1",
    threadTs: "1.1",
    terminalId: "wA:p1",
    promptId: await postedButtonPromptId(),
    num: "1",
  });
  assert.deepEqual(pairingKeys, ["C1"]);
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
  const handler = new CommandHandler(NO_TERMINALS, pairingStore, engine, notifier, OWNER);
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

test("ExpectationLost from Slack answers tells the user to inspect the terminal", async () => {
  const replies: string[] = [];
  const notifier = {
    async postReply(_channel: string, _threadTs: string, text: string) {
      replies.push(text);
    },
  } as unknown as Notifier;
  const pairingStore = { get: () => BUTTON_PAIRING } as unknown as PairingStore;
  const makeHandler = (engine: Partial<TurnEngine>): CommandHandler =>
    new CommandHandler(NO_TERMINALS, pairingStore, engine as TurnEngine, notifier, OWNER);
  const lost = new ExpectationLost("prompt changed");
  const message = "画面が変わったため、回答を途中で止めました。端末で確かめてください";

  await makeHandler({
    async answerQuestionButton() {
      throw lost;
    },
  }).handleAskUserQuestionButton({
    channel: "C1",
    threadTs: "1.1",
    terminalId: BUTTON_PAIRING.paneId,
    promptId: 1,
    optionIndex: 0,
  });
  assert.deepEqual(replies.splice(0), [message]);

  await makeHandler({
    async answerQuestionMultiSelect() {
      throw lost;
    },
  }).handleAskUserQuestionMultiSelect({
    channel: "C1",
    threadTs: "1.1",
    terminalId: BUTTON_PAIRING.paneId,
    promptId: 1,
    optionIndices: [0],
  });
  assert.deepEqual(replies.splice(0), [message]);
  const reviewMessage = "確認画面を確かめられなかったので送信していません。端末で確かめてください";
  await makeHandler({
    async answerQuestionMultiSelect() {
      throw new ExpectationLost(reviewMessage, reviewMessage);
    },
  }).handleAskUserQuestionMultiSelect({
    channel: "C1",
    threadTs: "1.1",
    terminalId: BUTTON_PAIRING.paneId,
    promptId: 1,
    optionIndices: [0],
  });
  assert.deepEqual(replies.splice(0), [reviewMessage]);

  await makeHandler({
    async answerPermissionButton() {
      throw lost;
    },
  }).handlePermissionButton({
    channel: "C1",
    threadTs: "1.1",
    terminalId: BUTTON_PAIRING.paneId,
    promptId: 1,
    num: "1",
  });
  assert.deepEqual(replies.splice(0), [message]);

  await makeHandler({
    async answerQuestionFreeText() {
      throw lost;
    },
  }).handleFreeTextMessage({ channel: "C1", threadTs: "1.1", text: "answer" });
  assert.deepEqual(replies.splice(0), [message]);

  await makeHandler({
    async answerQuestionFreeText() {
      return { ok: false, reason: "not-pending" };
    },
    async answerPlanFeedback() {
      throw lost;
    },
  }).handleFreeTextMessage({ channel: "C1", threadTs: "1.1", text: "feedback" });
  assert.deepEqual(replies.splice(0), [message]);

  await assert.rejects(
    makeHandler({
      async answerPermissionButton() {
        throw new Error("unexpected");
      },
    }).handlePermissionButton({
      channel: "C1",
      threadTs: "1.1",
      terminalId: BUTTON_PAIRING.paneId,
      promptId: 1,
      num: "1",
    }),
    /unexpected/,
  );
});

test("an Orca message-path miss keeps the pairing for watcher grace", async () => {
  const pairing: Pairing = { ...BUTTON_PAIRING, paneId: "orca:tab-7:leaf-2" };
  let existsCalls = 0;
  let removed = 0;
  const replies: string[] = [];
  const terminals = {
    async exists(target: string) {
      assert.equal(target, pairing.paneId);
      existsCalls++;
      return false;
    },
  } as unknown as Terminals;
  const engine = {
    isBusy: () => false,
    async startTurn() {
      throw new Error("agent-not-found");
    },
    answerQuestionFreeText: async () => ({ ok: false, reason: "not-pending" }),
    answerPlanFeedback: async () => ({ ok: false, reason: "not-pending" }),
  } as unknown as TurnEngine;
  const pairingStore = {
    get: () => pairing,
    remove(key: string) {
      assert.equal(key, pairing.key);
      removed++;
      return true;
    },
  } as unknown as PairingStore;
  const notifier = {
    async postReply(_channel: string, _threadTs: string, text: string) {
      replies.push(text);
    },
  } as unknown as Notifier;

  await new CommandHandler(terminals, pairingStore, engine, notifier, OWNER).handleMention({
    channel: "C1",
    threadTs: "1.1",
    userId: OWNER,
    text: "do the task",
    ts: "1.2",
  });

  assert.equal(existsCalls, 1);
  assert.equal(removed, 0, "the watcher, not one command-path miss, owns Orca unpairing");
  assert.equal(replies.length, 1);
  assert.match(replies[0]!, /ターミナル.*現在.*到達できません/);
  assert.match(replies[0]!, /復帰しない場合/);
  assert.match(replies[0]!, /自動.*解除/);
  assert.doesNotMatch(replies[0]!, /ペアリングを解除しました/);
});

test("Herdr command-path confirmed absence still unpairs despite a stale Orca tag", async () => {
  const pairing: Pairing = { ...BUTTON_PAIRING, backend: "orca" };
  let removed = 0;
  const replies: string[] = [];
  const terminals = { async exists() { return false; } } as unknown as Terminals;
  const engine = {
    isBusy: () => false,
    async startTurn() {
      throw new Error("agent-not-found");
    },
    answerQuestionFreeText: async () => ({ ok: false, reason: "not-pending" }),
    answerPlanFeedback: async () => ({ ok: false, reason: "not-pending" }),
  } as unknown as TurnEngine;
  const pairingStore = {
    get: () => pairing,
    remove(key: string) {
      assert.equal(key, pairing.key);
      removed++;
      return true;
    },
  } as unknown as PairingStore;
  const notifier = {
    async postReply(_channel: string, _threadTs: string, text: string) {
      replies.push(text);
    },
  } as unknown as Notifier;

  await new CommandHandler(terminals, pairingStore, engine, notifier, OWNER).handleMention({
    channel: "C1",
    threadTs: "1.1",
    userId: OWNER,
    text: "do the task",
    ts: "1.2",
  });

  assert.equal(removed, 1);
  assert.deepEqual(replies, ["⚠️ インスタンスが見つかりません。ペアリングを解除しました。"]);
});

function ompAgentForCommands(target = "orca:tab-7:leaf-2"): AgentInfo {
  const sessionId = "9a51b84e-610c-4d9e-bb20-28d7c850c552";
  const transcriptIdentity = { path: "/tmp/omp-session.jsonl", device: "1", inode: "2" };
  return {
    ref: { target, pid: 42, processStartedAt: 1, agentKind: "omp", sessionId, transcriptIdentity },
    backend: "orca",
    agent: "omp",
    sessionId,
    transcriptIdentity,
    cwd: "/tmp/project",
    evidence: { kind: "hint", state: "working", waitingSince: null },
    terminalTitle: null,
    terminalId: "orca-tab-7",
    displayId: target,
  };
}

test("blocked OMP thread replies are terminal-only for mentions and free text", async () => {
  const replies: string[] = [];
  let writes = 0;
  const engine = {
    isBusy: () => true,
    isOmpWaiting: () => true,
    async startTurn() {
      writes++;
    },
    async answerQuestionFreeText() {
      writes++;
      return { ok: true };
    },
    async answerPlanFeedback() {
      writes++;
      return { ok: true };
    },
  } as unknown as TurnEngine;
  const notifier = {
    async postReply(_channel: string, _threadTs: string, text: string) {
      replies.push(text);
    },
  } as unknown as Notifier;
  const handler = new CommandHandler(
    NO_TERMINALS,
    { get: () => BUTTON_PAIRING } as unknown as PairingStore,
    engine,
    notifier,
    OWNER,
  );

  await handler.handleMention({
    channel: "C1",
    threadTs: "1.1",
    userId: OWNER,
    text: "answer from Slack",
    ts: "1.2",
  });
  await handler.handleMention({
    channel: "C1",
    threadTs: "1.1",
    userId: OWNER,
    text: "log",
    ts: "1.3",
  });
  await handler.handleFreeTextMessage({ channel: "C1", threadTs: "1.1", text: "answer from Slack" });

  assert.deepEqual(replies, [
    "omp の質問・確認には、端末で答えてください",
    "omp の質問・確認には、端末で答えてください",
    "omp の質問・確認には、端末で答えてください",
  ]);
  assert.equal(writes, 0);
});

test("OMP mode plan and model commands use the exact unsupported reply without terminal writes", async () => {
  const target = "orca:tab-7:leaf-2";
  const pairing: Pairing = { ...BUTTON_PAIRING, paneId: target, backend: "orca" };
  const agent = ompAgentForCommands(target);
  const replies: string[] = [];
  let reads = 0;
  let writes = 0;
  let releases = 0;
  const terminals = {
    async get() {
      return agent;
    },
    async read() {
      reads++;
      return { text: "", draft: null, complete: true };
    },
    async submit() {
      writes++;
      return { status: "accepted", draftStashed: false };
    },
    openComposer() {
      writes++;
      return { async backTab() {} };
    },
  } as unknown as Terminals;
  const engine = {
    isBusy: () => false,
    isOmpWaiting: () => false,
    acquire() {
      return { cancelled: false, release() { releases++; }, signal: new AbortController().signal };
    },
  } as unknown as TurnEngine;
  const notifier = {
    async postReply(_channel: string, _threadTs: string, text: string) {
      replies.push(text);
    },
  } as unknown as Notifier;
  const handler = new CommandHandler(
    terminals,
    { get: () => pairing } as unknown as PairingStore,
    engine,
    notifier,
    OWNER,
  );
  for (const text of ["mode plan", "plan", "model gpt-test"]) {
    await handler.handleMention({ channel: "C1", threadTs: "1.1", userId: OWNER, text, ts: "1.2" });
  }

  assert.deepEqual(replies, ["omp では使えません", "omp では使えません", "omp では使えません"]);
  assert.equal(reads, 0);
  assert.equal(writes, 0);
  assert.equal(releases, 1, "the model lease is released after its read-only OMP refusal");
});

test("/model reports when Claude stashed the composer draft", async () => {
  const target = "orca:tab-7:leaf-2";
  const pairing: Pairing = { ...BUTTON_PAIRING, paneId: target, backend: "orca" };
  const agent: AgentInfo = {
    ...ompAgentForCommands(target),
    agent: "claude",
    sessionId: null,
    ref: { target, pid: 42, processStartedAt: 1 },
    evidence: { kind: "classified", status: "idle" },
  };
  const replies: string[] = [];
  const submitted: string[] = [];
  const terminals = {
    async get() {
      return agent;
    },
    async read() {
      return { text: "", draft: null, complete: true };
    },
    async submit(_ref: unknown, text: string) {
      submitted.push(text);
      return { status: "accepted", draftStashed: true };
    },
  } as unknown as Terminals;
  const engine = {
    isBusy: () => false,
    acquire() {
      return { cancelled: false, release() {}, signal: new AbortController().signal };
    },
  } as unknown as TurnEngine;
  const notifier = {
    async postReply(_channel: string, _threadTs: string, text: string) {
      replies.push(text);
    },
  } as unknown as Notifier;

  await new CommandHandler(
    terminals,
    { get: () => pairing } as unknown as PairingStore,
    engine,
    notifier,
    OWNER,
  ).handleMention({ channel: "C1", threadTs: "1.1", userId: OWNER, text: "model sonnet", ts: "1.2" });

  assert.deepEqual(submitted, ["/model sonnet"]);
  assert.equal(replies.length, 1);
  assert.ok(replies[0].endsWith(
    "\n📥 orca の入力欄の書きかけを一時退避して送りました。Claude Code 2.1.287 では送信の後に入力欄へ戻ります。戻っていなければ、入力欄が空（打った文字も灰色の提案も無い）のときに Ctrl+S を押すと戻ります。",
  ));
});
test("/model posts state-aware submit failures with the composer state", async () => {
  const target = "orca:tab-7:leaf-2";
  const pairing: Pairing = { ...BUTTON_PAIRING, paneId: target, backend: "orca" };
  const agent: AgentInfo = {
    ...ompAgentForCommands(target),
    agent: "claude",
    sessionId: null,
    ref: { target, pid: 42, processStartedAt: 1 },
    evidence: { kind: "classified", status: "idle" },
  };
  const stashed = { probe: null, stash: "stashed", submitUncertain: false } as const;
  const scenarios = [
    {
      name: "refusal after a confirmed stash",
      error: new SubmitRefused("stash-unverified", "internal refusal", stashed),
      expected:
        "⚠️ orca の入力欄の書きかけを Ctrl+S で退避しようとしましたが、送れる状態か確かめられなかったため、送信していません。 送信の前に、入力欄の書きかけを Ctrl+S で退避しました。入力欄が空（打った文字も灰色の提案も無い）のときに Ctrl+S を押すと戻ります。文字があるときに押すと、退避した書きかけは消えます。 端末で確かめてください。",
    },
    {
      name: "unknown final write after a confirmed stash",
      error: new WriteOutcomeUnknown(new Error("transport failed"), { ...stashed, submitUncertain: true }),
      expected:
        "送信できたか確認できません。端末を確かめてください 送信の前に、入力欄の書きかけを Ctrl+S で退避しました。送信されていれば、Claude Code が入力欄に戻していることがあります（2.1.287）。まず端末で入力欄を見て、書きかけが戻っておらず入力欄が空（打った文字も灰色の提案も無い）のときだけ Ctrl+S を押してください。",
    },
  ];

  for (const scenario of scenarios) {
    const replies: string[] = [];
    let releases = 0;
    const terminals = {
      async get() {
        return agent;
      },
      async submit() {
        throw scenario.error;
      },
    } as unknown as Terminals;
    const engine = {
      acquire() {
        return { cancelled: false, release() { releases++; }, signal: new AbortController().signal };
      },
    } as unknown as TurnEngine;
    const notifier = {
      async postReply(_channel: string, _threadTs: string, text: string) {
        replies.push(text);
      },
    } as unknown as Notifier;

    await new CommandHandler(
      terminals,
      { get: () => pairing } as unknown as PairingStore,
      engine,
      notifier,
      OWNER,
    ).handleMention({
      channel: "C1",
      threadTs: "1.1",
      userId: OWNER,
      text: "model sonnet",
      ts: "1.2",
    });

    assert.deepEqual(replies, [scenario.expected], scenario.name);
    assert.equal(releases, 1, scenario.name);
  }
});


test("OMP and stale Claude buttons refuse before invoking any answer channel", async () => {
  const target = "orca:tab-7:leaf-2";
  const pairing: Pairing = { ...BUTTON_PAIRING, paneId: target, backend: "orca" };
  const agent = ompAgentForCommands(target);
  const replies: string[] = [];
  let answers = 0;
  let reads = 0;
  const terminals = {
    async get() {
      return agent;
    },
    async read() {
      reads++;
      return { text: "", draft: null, complete: true };
    },
  } as unknown as Terminals;
  const engine = {
    isOmpWaiting: () => false,
    async answerQuestionButton() {
      answers++;
      return { ok: true };
    },
    async answerQuestionMultiSelect() {
      answers++;
      return { ok: true };
    },
    async answerPermissionButton() {
      answers++;
      return { ok: true };
    },
  } as unknown as TurnEngine;
  const notifier = {
    async postReply(_channel: string, _threadTs: string, text: string) {
      replies.push(text);
    },
  } as unknown as Notifier;
  const handler = new CommandHandler(
    terminals,
    { get: () => pairing } as unknown as PairingStore,
    engine,
    notifier,
    OWNER,
  );

  await handler.handleAskUserQuestionButton({
    channel: "C1", threadTs: "1.1", terminalId: target, promptId: 1, optionIndex: 0,
  });
  await handler.handleAskUserQuestionMultiSelect({
    channel: "C1", threadTs: "1.1", terminalId: target, promptId: 1, optionIndices: null,
  });
  await handler.handlePermissionButton({
    channel: "C1", threadTs: "1.1", terminalId: target, promptId: 1, num: "1",
  });

  assert.deepEqual(replies, ["もう回答できません", "もう回答できません", "もう回答できません"]);
  assert.equal(answers, 0);
  assert.equal(reads, 0);
});

test("disconnect cancels an OMP lease without sending terminal input", async () => {
  let cancelled = 0;
  let removed = 0;
  const replies: string[] = [];
  const engine = {
    cancelPane() {
      cancelled++;
    },
  } as unknown as TurnEngine;
  const ompPairing: Pairing = { ...BUTTON_PAIRING, paneId: "orca:tab-7:leaf-2", backend: "orca" };
  const pairingStore = {
    get: () => ompPairing,
    remove() {
      removed++;
      return true;
    },
  } as unknown as PairingStore;
  const notifier = {
    async postReply(_channel: string, _threadTs: string, text: string) {
      replies.push(text);
    },
  } as unknown as Notifier;
  await new CommandHandler(NO_TERMINALS, pairingStore, engine, notifier, OWNER).handleMention({
    channel: "C1", threadTs: "1.1", userId: OWNER, text: "disconnect", ts: "1.2",
  });

  assert.equal(cancelled, 1);
  assert.equal(removed, 1);
  assert.deepEqual(replies, ["🔌 接続を解除しました。"]);
});

test("a mention while a question waits for a typed answer answers it instead of being refused as busy", async () => {
  const replies: string[] = [];
  const answered: string[] = [];
  let started = 0;
  let pending: "question" | "plan" | null = "question";
  const engine = {
    isBusy: () => true,
    async startTurn() {
      started++;
    },
    async answerQuestionFreeText(_paneId: string, text: string) {
      if (pending !== "question") return { ok: false, reason: "not-pending" };
      answered.push(`question: ${text}`);
      return { ok: true };
    },
    async answerPlanFeedback(_paneId: string, text: string) {
      if (pending !== "plan") return { ok: false, reason: "not-pending" };
      answered.push(`plan: ${text}`);
      return { ok: true };
    },
  } as unknown as TurnEngine;
  const handler = new CommandHandler(
    NO_TERMINALS,
    { get: () => BUTTON_PAIRING } as unknown as PairingStore,
    engine,
    {
      async postReply(_channel: string, _threadTs: string, text: string) {
        replies.push(text);
      },
    } as unknown as Notifier,
    OWNER,
  );
  const mention = (text: string) => handler.handleMention({ channel: "C1", threadTs: "1.1", userId: OWNER, text, ts: "1.2" });

  await mention("審査員に触ってもらう前提で、管理者の role を分けたい");
  pending = "plan";
  await mention("テストの節を先に書いて");
  assert.deepEqual(answered, ["question: 審査員に触ってもらう前提で、管理者の role を分けたい", "plan: テストの節を先に書いて"]);
  assert.deepEqual(replies, []);

  pending = null;
  await mention("次の作業もお願い");
  assert.equal(replies.length, 1, "with nothing waiting, a running turn still refuses the message");
  assert.match(replies[0], /実行中/u);
  assert.equal(started, 0);
});
