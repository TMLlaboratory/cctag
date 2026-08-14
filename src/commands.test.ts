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
