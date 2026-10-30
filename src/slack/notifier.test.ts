import { test } from "node:test";
import assert from "node:assert/strict";
import type { WebClient } from "@slack/web-api";
import { downloadSlackFile, formatThreadHistorySinceLastBotPost } from "./notifier.js";
import { narrowedMaxFileBytes } from "../spoke/notifier.js";

const CAP = 1024;
const FILE = { id: "F1", name: "big.png", downloadUrl: "https://files.slack.example/big.png" };

/** A client that must never be reached — these cases resolve from the event's
 *  own download URL, so any files.info call would be a wasted API round trip. */
const unusedClient = {
  files: {
    info: async () => {
      throw new Error("files.info should not be called when the event carried a URL");
    },
  },
} as unknown as WebClient;

function stubFetch(response: Response): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => response) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function streamOf(chunks: Uint8Array[], onCancel?: () => void): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
    cancel() {
      onCancel?.();
    },
  });
}

test("a declared content-length over the cap is refused before any transfer", async () => {
  let bodyTouched = false;
  const res = new Response(
    streamOf([new Uint8Array(10)], () => {
      bodyTouched = true;
    }),
    { headers: { "content-type": "image/png", "content-length": String(CAP + 1) } },
  );
  const restore = stubFetch(res);
  try {
    assert.equal(await downloadSlackFile(unusedClient, "xoxb-test", FILE, CAP), null);
    assert.equal(bodyTouched, false);
  } finally {
    restore();
  }
});

test("a stream that outgrows the cap is abandoned mid-transfer", async () => {
  // The dangerous case: no content-length (or an untruthful event size), so the
  // only defence is the running total while reading.
  let cancelled = false;
  const chunk = new Uint8Array(400);
  const res = new Response(streamOf([chunk, chunk, chunk, chunk], () => (cancelled = true)), {
    headers: { "content-type": "image/png" },
  });
  const restore = stubFetch(res);
  try {
    assert.equal(await downloadSlackFile(unusedClient, "xoxb-test", FILE, CAP), null);
    assert.equal(cancelled, true, "the reader should be cancelled rather than drained");
  } finally {
    restore();
  }
});

test("a file within the cap comes back as base64", async () => {
  const bytes = Buffer.from("png-bytes");
  const res = new Response(streamOf([new Uint8Array(bytes)]), { headers: { "content-type": "image/png" } });
  const restore = stubFetch(res);
  try {
    assert.equal(await downloadSlackFile(unusedClient, "xoxb-test", FILE, CAP), bytes.toString("base64"));
  } finally {
    restore();
  }
});

test("an HTML response is treated as a missing files:read scope, not as content", async () => {
  const res = new Response(streamOf([new Uint8Array(Buffer.from("<html>sign in</html>"))]), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
  const restore = stubFetch(res);
  try {
    assert.equal(await downloadSlackFile(unusedClient, "xoxb-test", FILE, CAP), null);
  } finally {
    restore();
  }
});

test("an error status yields no content", async () => {
  const restore = stubFetch(new Response("nope", { status: 403 }));
  try {
    assert.equal(await downloadSlackFile(unusedClient, "xoxb-test", FILE, CAP), null);
  } finally {
    restore();
  }
});

test("the Spoke clamps its byte cap to a smaller Hub cap", () => {
  // The reported mismatch: Spoke 8MB against Hub 1MB silently dropped a 2MB file.
  assert.equal(narrowedMaxFileBytes(8 * 1024 * 1024, 1024 * 1024), 1024 * 1024);
});

test("the Spoke keeps its own cap when the Hub's is larger or unreported", () => {
  assert.equal(narrowedMaxFileBytes(1024, 8 * 1024), 1024);
  // A Hub too old to report one sends nothing at all.
  assert.equal(narrowedMaxFileBytes(1024, undefined), 1024);
  assert.equal(narrowedMaxFileBytes(1024, 0), 1024);
  assert.equal(narrowedMaxFileBytes(1024, "1MB"), 1024);
});

const BOT = "UBOT";
const THREAD = "1700000000.000100";

type FakeMessage = { ts: string; user?: string; text: string };

/**
 * A conversations.replies that pages oldest-first like Slack's: the parent
 * always comes first, `oldest` bounds the replies, and a cursor is the index of
 * the next reply.
 */
function threadClient(replies: FakeMessage[], opts: { failOnCall?: number } = {}) {
  const calls: { oldest?: string; cursor?: string }[] = [];
  const client = {
    conversations: {
      replies: async (args: { limit: number; cursor?: string; oldest?: string }) => {
        calls.push({ oldest: args.oldest, cursor: args.cursor });
        if (opts.failOnCall === calls.length) throw new Error("ratelimited");
        const inWindow = replies.filter((m) => args.oldest === undefined || Number(m.ts) >= Number(args.oldest));
        const start = args.cursor ? Number(args.cursor) : 0;
        const page = inWindow.slice(start, start + args.limit);
        const next = start + args.limit < inWindow.length ? String(start + args.limit) : "";
        const parent = { ts: THREAD, user: "UASAMI", text: "parent" };
        return { messages: start === 0 ? [parent, ...page] : page, response_metadata: { next_cursor: next } };
      },
    },
    users: { info: async ({ user }: { user: string }) => ({ user: { real_name: user } }) },
  } as unknown as WebClient;
  return { client, calls };
}

/** `count` replies a minute apart, starting a minute after the parent. */
function replies(count: number, botAt: number[] = []): FakeMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    ts: (1700000000 + 60 * (i + 1)).toFixed(6),
    user: botAt.includes(i) ? BOT : "UKUMOI",
    text: `m${i}`,
  }));
}

test("log reads the tail of a thread longer than the old ten-page cap", async () => {
  // 2,500 replies over ~42 hours: the old reader stopped at 2,000 and reported
  // what followed the last bot post *in those* as the newest history.
  const thread = replies(2500, [1990, 2497]);
  const { client, calls } = threadClient(thread);
  const lines = await formatThreadHistorySinceLastBotPost(client, "C1", THREAD, thread[2499]!.ts, BOT);
  assert.deepEqual(lines, ["UKUMOI: m2498"]);
  assert.equal(calls.length, 8, "one day of replies, paged, and nothing older");
  assert.ok(calls.every((c) => c.oldest !== undefined));
});

test("log falls back to the whole thread when cctag has not posted for a week", async () => {
  const thread = replies(3, [0]).map((m, i) => ({ ...m, ts: (1700000000 + 10 * 86_400 * (i + 1)).toFixed(6) }));
  const { client, calls } = threadClient(thread);
  const lines = await formatThreadHistorySinceLastBotPost(client, "C1", THREAD, thread[2]!.ts, BOT);
  assert.deepEqual(lines, ["UKUMOI: m1"]);
  assert.deepEqual(
    calls.map((c) => c.oldest === undefined),
    [false, false, true],
  );
});

test("log leaves out a parent older than the window it read", async () => {
  const thread = replies(3, []);
  thread.push({ ts: (1700000000 + 30 * 86_400).toFixed(6), user: BOT, text: "done" });
  thread.push({ ts: (1700000000 + 30 * 86_400 + 60).toFixed(6), user: "UKUMOI", text: "after" });
  const { client } = threadClient(thread);
  const lines = await formatThreadHistorySinceLastBotPost(client, "C1", THREAD, "1702592400.000000", BOT);
  assert.deepEqual(lines, ["UKUMOI: after"]);
});

test("a failed page fails the whole read rather than returning a prefix", async () => {
  const thread = replies(500, [10]);
  const { client } = threadClient(thread, { failOnCall: 2 });
  await assert.rejects(formatThreadHistorySinceLastBotPost(client, "C1", THREAD, thread[499]!.ts, BOT), /ratelimited/);
});
