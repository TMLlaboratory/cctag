import { homedir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import type { IncomingFile } from "../attachments.js";
import { loadSpokeConfig } from "../config.js";
import { HerdrClient } from "../herdr/client.js";
import { PairingStore } from "../pairing.js";
import { TurnEngine } from "../turn.js";
import { CommandHandler, stripComposerAttribution, stripMention } from "../commands.js";
import { BackgroundWatcher } from "../watcher.js";
import { WsRpc } from "../ws/rpc.js";
import { WsNotifier } from "./notifier.js";

function wsUrlFor(hubUrl: string): string {
  return hubUrl.replace(/\/+$/, "") + "/spoke";
}

/**
 * One machine can run multiple Spokes (one per Slack workspace/Hub, via
 * CCTAG_ENV_FILE — see config.ts). All of them talk to the same local herdr
 * daemon, so they'd silently clobber each other's pairing state if they
 * shared one `~/.cctag/pairings.json`. Namespace it by Hub URL automatically
 * so no extra config is needed for this to just work.
 */
function pairingStorePathFor(hubUrl: string): string {
  const safe = hubUrl.replace(/[^a-zA-Z0-9]/g, "-");
  return join(homedir(), ".cctag", `pairings-${safe}.json`);
}

function connectOnce(config: ReturnType<typeof loadSpokeConfig>): Promise<void> {
  const herdr = new HerdrClient(config.herdrBin);
  const pairingStore = new PairingStore(pairingStorePathFor(config.hubUrl));

  return new Promise((resolve, reject) => {
    // Sent as a header rather than a URL query param — query strings
    // routinely end up in reverse-proxy/HTTP access logs.
    const ws = new WebSocket(wsUrlFor(config.hubUrl), {
      headers: { authorization: `Bearer ${config.spokeToken}` },
    });

    ws.on("open", async () => {
      const rpc = new WsRpc(ws);
      const notifier = new WsNotifier(rpc);
      const turnEngine = new TurnEngine(herdr, notifier, {
        turnTimeoutMs: config.turnTimeoutMs,
        pollIntervalMs: config.pollIntervalMs,
        maxFileBytes: config.maxFileBytes,
        maxFileCount: config.maxFileCount,
      });
      const commands = new CommandHandler(herdr, pairingStore, turnEngine, notifier, config.ownerUserId, {
        maxFileBytes: config.maxFileBytes,
        maxFileCount: config.maxFileCount,
      });
      const watcher = new BackgroundWatcher(herdr, pairingStore, turnEngine, notifier);
      watcher.start();
      ws.once("close", () => watcher.stop());

      pairingStore.onChange = (change) => {
        rpc.notify("pairing_changed", {
          channel: change.pairing.channel,
          threadTs: change.pairing.threadTs,
          action: change.action,
        });
      };

      rpc.onCall("app_mention", async (payload) => {
        const p = payload as { channel: string; threadTs: string; userId: string; text: string; ts: string; files?: IncomingFile[] };
        const text = stripMention(stripComposerAttribution(p.text));
        await commands.handleMention({
          channel: p.channel,
          threadTs: p.threadTs,
          userId: p.userId,
          text,
          ts: p.ts,
          // Absent when the Hub predates attachment support — an older Hub just
          // never sends the field, and the mention still works as plain text.
          files: p.files ?? [],
        });
        return {};
      });

      rpc.onCall("message", async (payload) => {
        const p = payload as { channel: string; threadTs: string; text: string };
        const text = stripComposerAttribution(p.text).trim();
        if (!text || /<@[^>]+>/.test(text)) return {};
        await commands.handleFreeTextMessage({ channel: p.channel, threadTs: p.threadTs, text });
        return {};
      });

      rpc.onCall("pair_select", async (payload) => {
        // Field is named terminalId on the wire (Hub compat) but actually
        // carries a paneId — see PairSelectContext.terminalId's doc comment.
        const p = payload as { channel: string; threadTs: string; userId: string; terminalId: string };
        await commands.handlePairSelect(p);
        return {};
      });

      rpc.onCall("aq_answer", async (payload) => {
        const p = payload as { channel: string; threadTs: string; value: string };
        const v = JSON.parse(p.value) as { t: string; p: number; o: number };
        await commands.handleAskUserQuestionButton({ channel: p.channel, threadTs: p.threadTs, terminalId: v.t, promptId: v.p, optionIndex: v.o });
        return {};
      });

      rpc.onCall("perm_choice", async (payload) => {
        const p = payload as { channel: string; threadTs: string; value: string };
        const v = JSON.parse(p.value) as { t: string; p: number; n: string };
        await commands.handlePermissionButton({ channel: p.channel, threadTs: p.threadTs, terminalId: v.t, promptId: v.p, num: v.n });
        return {};
      });

      try {
        const result = await rpc.call<{ ok: boolean }>("register", {
          ownerUserId: config.ownerUserId,
          pairings: pairingStore.list().map((p) => ({ channel: p.channel, threadTs: p.threadTs })),
        });
        if (!result.ok) {
          throw new Error(
            "Hub rejected registration — this token is not authorized for CCTAG_OWNER_USER_ID " +
              `${config.ownerUserId}. Check that the token and owner ID were issued together.`,
          );
        }
        console.log("[spoke] registered with hub");
      } catch (err) {
        reject(err);
        return;
      }
    });

    ws.on("close", (code, reason) => {
      console.log(`[spoke] disconnected from hub (code ${code}${reason ? `: ${reason}` : ""})`);
      resolve();
    });
    ws.on("error", (err) => {
      console.error("[spoke] connection error:", err.message);
    });
  });
}

// A connection that registered and then closed almost immediately (a bad
// network path, a Hub-side hiccup, ...) isn't "success" — it's the failure
// mode most likely to repeat. Only treat a connection as stable enough to
// reset the backoff if it stayed up for a while; otherwise keep backing off
// so a rapid connect/drop cycle can't hammer the Hub once per second forever.
const STABLE_CONNECTION_MS = 10_000;

async function main() {
  const config = loadSpokeConfig();
  console.log(`[spoke] connecting to ${config.hubUrl} as owner ${config.ownerUserId}...`);

  let backoffMs = 1_000;
  for (;;) {
    const connectedAt = Date.now();
    try {
      await connectOnce(config);
      if (Date.now() - connectedAt >= STABLE_CONNECTION_MS) {
        backoffMs = 1_000;
      }
    } catch (err) {
      console.error("[spoke] connection failed:", err instanceof Error ? err.message : err);
    }
    await new Promise((r) => setTimeout(r, backoffMs));
    backoffMs = Math.min(backoffMs * 2, 30_000);
    console.log("[spoke] reconnecting...");
  }
}

main().catch((err) => {
  console.error("cctag-spoke failed:", err);
  process.exit(1);
});
