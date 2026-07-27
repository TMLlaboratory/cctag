import { test } from "node:test";
import assert from "node:assert/strict";
import type { WebClient } from "@slack/web-api";
import { downloadSlackFile } from "./notifier.js";
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
