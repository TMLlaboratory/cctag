import { test } from "node:test";
import assert from "node:assert/strict";
import type { WebClient } from "@slack/web-api";
import { resolveUserMentions } from "./notifier.js";

const BOT = "U0BFT8ZALMV";

/** Answers for the ids it knows and fails for the rest, as Slack does. */
function fakeClient(directory: Record<string, { display_name?: string; real_name?: string; name?: string }>): {
  client: WebClient;
  calls: string[];
} {
  const calls: string[] = [];
  const client = {
    users: {
      async info({ user }: { user: string }) {
        calls.push(user);
        const entry = directory[user];
        if (!entry) throw new Error("user_not_found");
        return { user: { profile: { display_name: entry.display_name ?? "" }, real_name: entry.real_name, name: entry.name } };
      },
    },
  } as unknown as WebClient;
  return { client, calls };
}

test("other people's mentions become names, and cctag's own is left for stripMention", async () => {
  // Live messages used to have every mention deleted, so a question that turned on
  // who said what — "「@佐藤 の指摘と @松浦 の案、どちらを採る？」" — reached the agent
  // with the names cut out of it.
  const { client } = fakeClient({
    U0SATO: { display_name: "佐藤" },
    U0MATSU: { display_name: "松浦" },
  });
  const out = await resolveUserMentions(
    client,
    `<@${BOT}> <@U0SATO> の指摘と <@U0MATSU> の案、どちらを採る？`,
    BOT,
  );
  assert.equal(out, `<@${BOT}> @佐藤 の指摘と @松浦 の案、どちらを採る？`);
});

test("an id nobody can resolve keeps its markup rather than losing the text", async () => {
  const { client } = fakeClient({});
  const out = await resolveUserMentions(client, "<@U0GHOST> は誰？", BOT);
  assert.equal(out, "<@U0GHOST> は誰？", "leaving it is recoverable; deleting it is not");
});

test("display_name wins, with real_name and the handle behind it", async () => {
  const { client } = fakeClient({
    U0A: { display_name: "げんど", real_name: "Gendo Kumoi", name: "gendo" },
    U0B: { real_name: "Gendo Kumoi", name: "gendo" },
    U0C: { name: "gendo" },
  });
  assert.equal(await resolveUserMentions(client, "<@U0A>", BOT), "@げんど");
  assert.equal(await resolveUserMentions(client, "<@U0B>", BOT), "@Gendo Kumoi");
  assert.equal(await resolveUserMentions(client, "<@U0C>", BOT), "@gendo");
});

test("each id is looked up once, however often it appears", async () => {
  // A thread's history is resolved line by line through one shared cache, and a
  // lab thread mentions the same handful of people over and over.
  const { client, calls } = fakeClient({ U0SATO: { display_name: "佐藤" } });
  const cache = new Map<string, string>();
  await resolveUserMentions(client, "<@U0SATO> <@U0SATO>", BOT, cache);
  await resolveUserMentions(client, "また <@U0SATO>", BOT, cache);
  assert.deepEqual(calls, ["U0SATO"]);
});

test("the bot is never looked up", async () => {
  const { client, calls } = fakeClient({});
  await resolveUserMentions(client, `<@${BOT}> hello`, BOT);
  assert.deepEqual(calls, [], "its own id is known and its markup is wanted intact");
});

test("text with no mentions is returned untouched and costs nothing", async () => {
  const { client, calls } = fakeClient({});
  assert.equal(await resolveUserMentions(client, "ふつうの文章です", BOT), "ふつうの文章です");
  assert.deepEqual(calls, []);
});
