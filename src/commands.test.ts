import { test } from "node:test";
import assert from "node:assert/strict";
import { CommandHandler } from "./commands.js";
import type { HerdrClient } from "./herdr/client.js";
import type { Notifier } from "./notifier.js";
import type { PairingStore } from "./pairing.js";
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
  assert.match(out, /^\[Slack: 佐藤 さんからの依頼です（オーナー本人ではありません）\]\n/);
  assert.ok(out.endsWith("この方針で進めて"), "the message itself is untouched");
});

test("the owner's message is passed through exactly as before", async () => {
  const { attributed } = await import("./commands.js");
  assert.equal(attributed("この方針で進めて", undefined), "この方針で進めて");
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
