import { createConnection } from "node:net";

const MAX_SCREEN_BYTES = 8 * 1024 * 1024;

export interface HcObservedScreen<T> {
  terminal: T;
  ansi: string;
}

/** Read the initial paint on a read-only channel. The plain read drops the caret and trailing spaces. */
export function observeHcScreen<T>(path: string, terminal: string): Promise<HcObservedScreen<T> | null> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    let pending = Buffer.alloc(0);
    let framed = false;
    let channel: number | undefined;
    let record: T | undefined;
    const finish = (screen: HcObservedScreen<T> | null) => {
      clearTimeout(timeout);
      socket.destroy();
      resolve(screen);
    };
    const timeout = setTimeout(() => finish(null), 2_000);
    socket.on("error", () => finish(null));
    socket.on("close", () => finish(null));
    socket.on("connect", () => {
      socket.write(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "hello", params: { framed: true, generation: 1 } }) + "\n");
    });
    socket.on("data", (chunk) => {
      if (pending.length + chunk.length > MAX_SCREEN_BYTES) return finish(null);
      pending = Buffer.concat([pending, chunk]);
      try {
        if (!framed) {
          const end = pending.indexOf(10);
          if (end < 0) return;
          const hello = JSON.parse(pending.subarray(0, end).toString());
          if (hello.id !== 0 || hello.result?.framed !== true) return finish(null);
          pending = pending.subarray(end + 1);
          framed = true;
          const request = Buffer.from(JSON.stringify({
            jsonrpc: "2.0", id: 1, method: "terminal.attach",
            params: { terminal, cols: 1, rows: 1, history: 0, observe: true },
          }));
          const header = Buffer.alloc(9);
          header.writeUInt32LE(request.length, 5);
          socket.write(Buffer.concat([header, request]));
        }
        while (pending.length >= 9) {
          const size = pending.readUInt32LE(5);
          if (size > MAX_SCREEN_BYTES - 9) return finish(null);
          if (pending.length < size + 9) return;
          const source = pending.readUInt32LE(0);
          const kind = pending[4];
          const payload = pending.subarray(9, 9 + size).toString();
          pending = pending.subarray(9 + size);
          if (source === 0 && kind === 0) {
            const reply = JSON.parse(payload);
            if (reply.id !== 1 || !Number.isSafeInteger(reply.result?.channel) || reply.result.channel <= 0 || !reply.result.terminal) {
              return finish(null);
            }
            channel = reply.result.channel;
            record = reply.result.terminal as T;
          } else if (source === channel && kind === 0 && record) {
            return finish({ terminal: record, ansi: payload });
          } else if (source === channel && kind === 2) {
            return finish(null);
          }
        }
      } catch {
        finish(null);
      }
    });
  });
}
