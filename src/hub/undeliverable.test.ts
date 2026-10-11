import { test } from "node:test";
import assert from "node:assert/strict";
import { RpcFailure } from "../ws/rpc.js";
import { undeliverableNotice } from "./undeliverable.js";

test("only a closed connection is reported as not delivered", () => {
  assert.match(undeliverableNotice(new RpcFailure("closed", "connection closed"))!, /届きませんでした/);
});

test("a timeout is reported without claiming the message was lost", () => {
  const notice = undeliverableNotice(new RpcFailure("timeout", 'rpc timeout waiting for "app_mention"'))!;
  assert.match(notice, /応答がありません/);
  assert.doesNotMatch(notice, /届きませんでした|接続が切れて/);
});

test("an exception on the Spoke, or one that is not an RPC failure, gets no notice", () => {
  assert.equal(undeliverableNotice(new RpcFailure("remote", "boom")), null);
  assert.equal(undeliverableNotice(new Error("boom")), null);
});
