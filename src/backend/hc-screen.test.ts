import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeHcScreen } from "./hc-screen.js";

function frame(source: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(9);
  header.writeUInt32LE(source, 0);
  header.writeUInt32LE(payload.length, 5);
  return Buffer.concat([header, payload]);
}

test("observeHcScreen joins an initial paint herdr-core split into 16 KiB frames, even inside a character", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cctag-hc-screen-"));
  const path = join(dir, "hc.sock");
  const paint = Buffer.from("\x1b[H\x1b[2J" + "あ".repeat(6000) + "\x1b]7501;state=idle:app=claude-code\x1b\\");
  const split = 16384; // 16384 is not a multiple of 3, so "あ" is cut across frames.
  const server = createServer((socket) => {
    let hello = false;
    socket.on("data", () => {
      if (!hello) {
        hello = true;
        socket.write(JSON.stringify({ jsonrpc: "2.0", id: 0, result: { framed: true } }) + "\n");
        return;
      }
      const reply = { jsonrpc: "2.0", id: 1, result: { channel: 7, terminal: { address: "t1" } } };
      socket.write(Buffer.concat([
        frame(0, Buffer.from(JSON.stringify(reply))),
        frame(7, paint.subarray(0, split)),
      ]));
      setTimeout(() => socket.write(frame(7, paint.subarray(split))), 20);
    });
  });
  try {
    await new Promise<void>((resolve) => server.listen(path, resolve));
    const observed = await observeHcScreen<{ address: string }>(path, "t1");
    assert.equal(observed?.ansi, paint.toString());
    assert.equal(observed?.terminal.address, "t1");
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
