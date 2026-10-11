import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type WebSocket from "ws";
import { RpcFailure, WsRpc } from "./rpc.js";

/** Two WsRpc ends joined back to back, the way the Hub and a Spoke are. */
function pair() {
  const a = new EventEmitter() as EventEmitter & { OPEN: number; readyState: number; send(s: string): void };
  const b = new EventEmitter() as typeof a;
  for (const [self, other] of [[a, b], [b, a]] as const) {
    self.OPEN = 1;
    self.readyState = 1;
    self.send = (s) => queueMicrotask(() => other.emit("message", Buffer.from(s)));
  }
  return { a, b, hub: new WsRpc(a as unknown as WebSocket), spoke: new WsRpc(b as unknown as WebSocket) };
}

const failureKind = (kind: RpcFailure["kind"]) => (err: unknown) => err instanceof RpcFailure && err.kind === kind;

test("a call fails as remote when the other side's handler throws", async () => {
  const { hub, spoke } = pair();
  spoke.onCall("app_mention", () => {
    throw new Error("boom");
  });
  await assert.rejects(hub.call("app_mention", {}), failureKind("remote"));
});

test("a call fails as timeout when no result comes back", async () => {
  const { hub, spoke } = pair();
  spoke.onCall("app_mention", () => new Promise(() => {}));
  await assert.rejects(hub.call("app_mention", {}, 10), failureKind("timeout"));
});

test("a pending call fails as closed when the connection closes under it", async () => {
  const { a, hub, spoke } = pair();
  spoke.onCall("app_mention", () => new Promise(() => {}));
  const pending = hub.call("app_mention", {});
  a.emit("close");
  await assert.rejects(pending, failureKind("closed"));
});
