import type WebSocket from "ws";

type Handler = (payload: unknown) => Promise<unknown> | unknown;
type NotifyHandler = (payload: unknown) => void;

/** Why a call() was rejected: the connection closed under it, no result came in
*  time, or the other side's handler threw. Only "closed" says the connection
 *  is gone; the other two leave it open and the call possibly still running. */
export class RpcFailure extends Error {
  constructor(
    readonly kind: "closed" | "timeout" | "remote",
    message: string,
  ) {
    super(message);
  }
}

type Envelope =
  | { kind: "call"; id: string; type: string; payload: unknown }
  | { kind: "result"; id: string; ok: true; result: unknown }
  | { kind: "result"; id: string; ok: false; error: string }
  | { kind: "notify"; type: string; payload: unknown };

/**
 * Symmetric JSON-RPC-over-WebSocket: either side can `call()` the other and
 * `onCall()` handle incoming calls, so the same class works for both the Hub
 * (dispatching Slack events to a Spoke) and the Spoke (proxying Notifier
 * calls back to the Hub) ends of the connection.
 */
export class WsRpc {
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  private callHandlers = new Map<string, Handler>();
  private notifyHandlers = new Map<string, NotifyHandler>();
  private seq = 0;

  constructor(private readonly ws: WebSocket) {
    ws.on("message", (data: WebSocket.RawData) => this.onMessage(data.toString()));
    ws.on("close", () => {
      for (const [, p] of this.pending) p.reject(new RpcFailure("closed", "connection closed"));
      this.pending.clear();
    });
  }

  private onMessage(raw: string): void {
    let msg: Envelope;
    try {
      msg = JSON.parse(raw) as Envelope;
    } catch {
      return;
    }

    if (msg.kind === "call") {
      const handler = this.callHandlers.get(msg.type);
      if (!handler) {
        this.send({ kind: "result", id: msg.id, ok: false, error: `no handler for "${msg.type}"` });
        return;
      }
      Promise.resolve()
        .then(() => handler(msg.payload))
        .then((result) => this.send({ kind: "result", id: msg.id, ok: true, result }))
        .catch((err: unknown) =>
          this.send({ kind: "result", id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) }),
        );
    } else if (msg.kind === "result") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new RpcFailure("remote", msg.error));
    } else if (msg.kind === "notify") {
      this.notifyHandlers.get(msg.type)?.(msg.payload);
    }
  }

  private send(obj: Envelope): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(obj));
  }

  call<T = unknown>(type: string, payload: unknown, timeoutMs = 20_000): Promise<T> {
    const id = `${Date.now()}-${++this.seq}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new RpcFailure("timeout", `rpc timeout waiting for "${type}"`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.send({ kind: "call", id, type, payload });
    });
  }

  onCall(type: string, handler: Handler): void {
    this.callHandlers.set(type, handler);
  }

  onNotify(type: string, handler: NotifyHandler): void {
    this.notifyHandlers.set(type, handler);
  }

  notify(type: string, payload: unknown): void {
    this.send({ kind: "notify", type, payload });
  }

  close(): void {
    this.ws.close();
  }
}
