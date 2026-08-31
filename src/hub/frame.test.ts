import { test } from "node:test";
import assert from "node:assert/strict";
import { maxFramePayload } from "./frame.js";

const MB = 1024 * 1024;

test("the frame cap leaves room for base64 and the JSON envelope", () => {
  // A 10MB file is 13.34MB of base64, so a cap set at the file size itself
  // would refuse every upload the Spoke is told it may send.
  const cap = maxFramePayload(10 * MB);
  assert.ok(cap > Math.ceil((10 * MB * 4) / 3), "base64 expansion must fit");
  assert.ok(cap < 16 * MB, `headroom should be modest, got ${(cap / MB).toFixed(1)}MB`);
});

test("the frame cap is far below ws's 100MiB default", () => {
  // The point of setting it at all. `upload_file` compares sizes only after the
  // frame is received and parsed, so the default let an oversized upload cost
  // the memory before being rejected — on a 954MB box with no swap.
  assert.ok(maxFramePayload(10 * MB) < 100 * MB / 4);
});

test("a tiny file cap does not shrink ordinary RPC traffic", () => {
  // register, post_message, update_message and the rest share this socket. A
  // deliberately small CCTAG_MAX_FILE_MB should limit files, not messages.
  assert.equal(maxFramePayload(1), 8 * MB);
  assert.equal(maxFramePayload(64 * 1024), 8 * MB);
});

test("a raised file cap raises the frame cap with it", () => {
  assert.ok(maxFramePayload(64 * MB) > maxFramePayload(10 * MB));
  assert.ok(maxFramePayload(64 * MB) > Math.ceil((64 * MB * 4) / 3));
});
