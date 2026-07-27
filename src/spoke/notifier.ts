import type { IncomingFile } from "../attachments.js";
import type { MessageHandle, Notifier } from "../notifier.js";
import type { WsRpc } from "../ws/rpc.js";

/** Proxies every Notifier call to the Hub over the WebSocket RPC connection. */
export class WsNotifier implements Notifier {
  constructor(private readonly rpc: WsRpc) {}

  async postReply(channel: string, threadTs: string, text: string): Promise<void> {
    await this.rpc.call("post_reply", { channel, threadTs, text });
  }

  async postMessage(channel: string, threadTs: string, text: string, blocks?: unknown[]): Promise<MessageHandle> {
    const { msgId } = await this.rpc.call<{ msgId: string }>("post_message", { channel, threadTs, text, blocks });
    return {
      update: async (newText: string, newBlocks?: unknown[]) => {
        await this.rpc.call("update_message", { msgId, text: newText, blocks: newBlocks });
      },
    };
  }

  async getPermalink(channel: string, ts: string): Promise<string | null> {
    const { permalink } = await this.rpc.call<{ permalink: string | null }>("get_permalink", { channel, ts });
    return permalink;
  }

  async getThreadHistorySinceLastBotPost(channel: string, threadTs: string, excludeTs: string): Promise<string[]> {
    const { lines } = await this.rpc.call<{ lines: string[] }>("get_thread_history", { channel, threadTs, excludeTs });
    return lines;
  }

  async uploadTextFile(
    channel: string,
    threadTs: string,
    args: { content: string; filename: string; title?: string; comment?: string },
  ): Promise<void> {
    await this.rpc.call("upload_text_file", { channel, threadTs, ...args });
  }

  async uploadFile(
    channel: string,
    threadTs: string,
    args: { contentB64: string; filename: string; title?: string; comment?: string },
  ): Promise<void> {
    await this.rpc.call("upload_file", { channel, threadTs, ...args }, FILE_RPC_TIMEOUT_MS);
  }

  async fetchIncomingFile(file: IncomingFile): Promise<string | null> {
    // Only the id and name go over the wire — the Hub re-resolves the download
    // URL from Slack itself (see downloadSlackFile), so the Spoke is never in a
    // position to fetch Slack files on its own.
    const { contentB64 } = await this.rpc.call<{ contentB64: string | null }>(
      "fetch_file",
      { fileId: file.id, name: file.name },
      FILE_RPC_TIMEOUT_MS,
    );
    return contentB64;
  }
}

/** File transfers move megabytes of base64 in one JSON message and involve a
 *  Slack API round trip on the Hub side — well past what the RPC default (20s,
 *  sized for chat.postMessage) allows for. */
const FILE_RPC_TIMEOUT_MS = 120_000;
