import { createConnection } from "node:net";
import { StringDecoder } from "node:string_decoder";

/** The legacy CLI prints only the text. Its API also reports truncation. */
export function readHerdrVisibleAnsi(socketPath: string, target: string): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    const decoder = new StringDecoder("utf8");
    let text = "";
    let bytes = 0;
    const finish = (value: string | null) => {
      clearTimeout(timeout);
      socket.destroy();
      resolve(value);
    };
    const timeout = setTimeout(() => finish(null), 2_000);
    socket.on("error", () => finish(null));
    socket.on("close", () => finish(null));
    socket.on("connect", () => {
      socket.write(JSON.stringify({
        id: "cctag:visible", method: "pane.read",
        params: { pane_id: target, source: "visible", format: "ansi", strip_ansi: false },
      }) + "\n");
    });
    socket.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) return finish(null);
      text += decoder.write(chunk);
      const end = text.indexOf("\n");
      if (end < 0) return;
      try {
        const reply = JSON.parse(text.slice(0, end));
        const read = reply.result?.read;
        finish(reply.id === "cctag:visible" && reply.result?.type === "pane_read" &&
          read?.pane_id === target && read.source === "visible" && read.format === "ansi" &&
          read.truncated === false && typeof read.text === "string" ? read.text : null);
      } catch {
        finish(null);
      }
    });
  });
}
