import { homedir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import type { AttachmentLimits, IncomingFile } from "../attachments.js";
import { hubSlug, type SpokeConfig } from "../config.js";
import { HerdrClient } from "../herdr/client.js";
import { PairingStore } from "../pairing.js";
import { TurnEngine } from "../turn.js";
import { CommandHandler, stripComposerAttribution, stripMention } from "../commands.js";
import { BackgroundWatcher } from "../watcher.js";
import { VERSION } from "../version.js";
import { WsRpc } from "../ws/rpc.js";
import { acquireSingleInstanceLock } from "./lock.js";
import { narrowedMaxFileBytes, WsNotifier } from "./notifier.js";

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
  return join(homedir(), ".cctag", `pairings-${hubSlug(hubUrl)}.json`);
}

// Liveness detection timings, hand-rolled with plain setTimeout rather than
// `ws` constructor options (handshakeTimeout etc.): this project ships a
// Bun-compiled native binary (scripts/build-native.sh), and Bun silently
// ignores `ws` options it hasn't implemented — measured directly, an
// unreachable-host connect with handshakeTimeout errors out under Node in 3s
// but sits there doing nothing under Bun after 8s+. An option that quietly
// no-ops on the actual ship target isn't a fix.
const CONNECT_TIMEOUT_MS = 15_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 90_000;

function connectOnce(config: SpokeConfig): Promise<void> {
  const herdr = new HerdrClient(config.herdrBin);
  const pairingStore = new PairingStore(pairingStorePathFor(config.hubUrl));

  return new Promise((resolve, reject) => {
    // Sent as a header rather than a URL query param — query strings
    // routinely end up in reverse-proxy/HTTP access logs.
    const ws = new WebSocket(wsUrlFor(config.hubUrl), {
      headers: { authorization: `Bearer ${config.spokeToken}` },
    });

    // 1. Connect-hang timeout: if the TCP handshake itself is black-holed,
    // neither "open" nor "error" nor "close" ever fires and this promise
    // would hang forever. Under Node, terminate() on a still-CONNECTING
    // socket forces a synchronous "close" that the handler below resolves
    // the promise on — but under Bun (the actual ship target), terminate()
    // on a CONNECTING socket is a silent no-op: no "close", no "error",
    // nothing (measured directly against an unreachable host). So this
    // timeout settles the promise itself rather than relying on "close",
    // and a `timedOut` flag guards against a late "open" starting a second
    // engine/watcher pair against a connection this function has already
    // given up on.
    let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const connectTimeout = setTimeout(() => {
      console.log(`[spoke] connect timed out after ${CONNECT_TIMEOUT_MS / 1000}s, terminating`);
      timedOut = true;
      ws.terminate();
      reject(new Error("connect timed out"));
    }, CONNECT_TIMEOUT_MS);

    ws.on("open", async () => {
      clearTimeout(connectTimeout);
      if (timedOut) {
        // The promise already settled (rejected) above. Getting here means
        // Bun completed the handshake anyway after terminate() was told to
        // abort it — close it and stop, same as the registration-failure
        // path below: two engines polling the same panes from one attempt
        // that already reported itself failed is exactly what abortAll()
        // exists to prevent.
        try {
          ws.close();
        } catch {
          /* already closing */
        }
        return;
      }

      // 2. Heartbeat: the reconnect loop in main() is entirely close-driven
      // (it only runs once connectOnce's promise settles), and until now
      // nothing ever made "close" fire on a half-open connection — one where
      // the TCP path silently stops delivering packets without either side
      // sending FIN/RST (common behind NAT/proxies/VPN split-tunnels). With
      // no heartbeat, that connection just sits there forever, believed
      // alive, delivering nothing. Ping every 30s; if no pong has landed in
      // the configured window, treat the connection as dead and terminate()
      // it so the existing reconnect loop actually gets a chance to run.
      // (Unlike the connect-hang case above, terminate() on an already-OPEN
      // socket does reliably emit "close" under both Node and Bun — measured
      // — so this half relies on the close handler below, same as before.)
      //
      // A single rescheduled setTimeout, not setInterval: the same reasoning
      // as the connect timeout above applies to every timer in this
      // function — hand-rolled, not a `ws`/WebSocket constructor option —
      // and setInterval doesn't buy anything setTimeout doesn't here, so
      // there is no reason to reach for the fixed-cadence primitive.
      let lastPongAt = Date.now();
      ws.on("pong", () => {
        lastPongAt = Date.now();
      });
      const scheduleHeartbeatCheck = () => {
        heartbeatTimer = setTimeout(() => {
          if (Date.now() - lastPongAt > PONG_TIMEOUT_MS) {
            console.log(`[spoke] no pong in ${PONG_TIMEOUT_MS / 1000}s, terminating`);
            ws.terminate();
            return;
          }
          ws.ping();
          scheduleHeartbeatCheck();
        }, HEARTBEAT_INTERVAL_MS);
      };
      scheduleHeartbeatCheck();

      const rpc = new WsRpc(ws);
      const notifier = new WsNotifier(rpc);
      // One object, shared by reference with the TurnEngine: registration below
      // narrows maxFileBytes to the Hub's cap, and the engine has to see it.
      const limits: AttachmentLimits = {
        maxFileBytes: config.maxFileBytes,
        maxFileCount: config.maxFileCount,
      };
      const turnEngine = new TurnEngine(
        herdr,
        notifier,
        { turnTimeoutMs: config.turnTimeoutMs, pollIntervalMs: config.pollIntervalMs, limits },
        pairingStore,
      );
      const commands = new CommandHandler(herdr, pairingStore, turnEngine, notifier, config.ownerUserId);
      const watcher = new BackgroundWatcher(herdr, pairingStore, turnEngine, notifier);
      ws.once("close", () => {
        // Both halves have to stop, not just the watcher: this connection's
        // engine holds poll loops whose only way to reach Slack was the notifier
        // wrapping the socket that just closed. See TurnEngine.abortAll.
        watcher.stop();
        const dropped = turnEngine.abortAll();
        if (dropped > 0) console.log(`[spoke] dropped ${dropped} in-flight turn(s) on disconnect`);
      });

      pairingStore.onChange = (change) => {
        rpc.notify("pairing_changed", {
          channel: change.pairing.channel,
          threadTs: change.pairing.threadTs,
          action: change.action,
        });
      };

      rpc.onCall("app_mention", async (payload) => {
        const p = payload as {
          channel: string;
          threadTs: string;
          userId: string;
          userName?: string;
          text: string;
          ts: string;
          files?: IncomingFile[];
        };
        const text = stripMention(stripComposerAttribution(p.text));
        await commands.handleMention({
          channel: p.channel,
          threadTs: p.threadTs,
          userId: p.userId,
          // Absent from an older Hub — the message is then simply unattributed.
          userName: p.userName,
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
        // actor* are absent from an older Hub, which simply leaves answers unmarked.
        const p = payload as { channel: string; threadTs: string; value: string; actorUserId?: string; actorName?: string };
        const v = JSON.parse(p.value) as { t: string; p: number; o: number };
        await commands.handleAskUserQuestionButton({
          channel: p.channel,
          threadTs: p.threadTs,
          terminalId: v.t,
          promptId: v.p,
          optionIndex: v.o,
          actorUserId: p.actorUserId,
          actorName: p.actorName,
        });
        return {};
      });

      rpc.onCall("perm_choice", async (payload) => {
        const p = payload as { channel: string; threadTs: string; value: string; actorUserId?: string; actorName?: string };
        const v = JSON.parse(p.value) as { t: string; p: number; n: string };
        await commands.handlePermissionButton({
          channel: p.channel,
          threadTs: p.threadTs,
          terminalId: v.t,
          promptId: v.p,
          num: v.n,
          actorUserId: p.actorUserId,
          actorName: p.actorName,
        });
        return {};
      });

      try {
        const result = await rpc.call<{ ok: boolean; maxFileBytes?: number }>("register", {
          ownerUserId: config.ownerUserId,
          pairings: pairingStore.list().map((p) => ({ channel: p.channel, threadTs: p.threadTs })),
          // Hub-side handling already tolerates unknown fields, so this is
          // safe against an older Hub. Purely diagnostic: a recent incident
          // investigation had no way to tell which Spoke build was talking
          // to the Hub and had to reconstruct the timeline from unified log
          // DNS resolution instead of a version string in a log line.
          version: VERSION,
        });
        if (!result.ok) {
          throw new Error(
            "Hub rejected registration — this token is not authorized for CCTAG_OWNER_USER_ID " +
              `${config.ownerUserId}. Check that the token and owner ID were issued together.`,
          );
        }
        const narrowed = narrowedMaxFileBytes(limits.maxFileBytes, result.maxFileBytes);
        if (narrowed !== limits.maxFileBytes) {
          console.log(
            `[spoke] file size cap narrowed to the Hub's ${(narrowed / 1024 / 1024).toFixed(1)}MB ` +
              `(local setting was ${(limits.maxFileBytes / 1024 / 1024).toFixed(1)}MB)`,
          );
          limits.maxFileBytes = narrowed;
        }
        console.log("[spoke] registered with hub");
        // Only now. Until the Hub has accepted this connection it refuses to act
        // on anything, and refuses *successfully*: an unauthorized post_message
        // comes back as `{ msgId: "" }`, not an error. A watcher started earlier
        // could therefore adopt a blocked pane, believe it had posted the prompt,
        // and hold that pane while Slack showed nothing at all.
        watcher.start();
      } catch (err) {
        // Closing the socket is the point. Rejecting alone left it open with the
        // watcher and engine of this attempt still live, while the reconnect loop
        // built a second set against a new connection — two engines polling the
        // same panes, which is exactly what abortAll() exists to prevent.
        watcher.stop();
        turnEngine.abortAll();
        if (heartbeatTimer) clearTimeout(heartbeatTimer);
        try {
          ws.close();
        } catch {
          /* already closing */
        }
        reject(err);
        return;
      }
    });

    ws.on("close", (code, reason) => {
      // Both liveness timers are scoped to this connection attempt — clear
      // them here so nothing leaks across reconnects (a stale heartbeat
      // interval would ping a socket that's already gone).
      clearTimeout(connectTimeout);
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
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
  // Checked before anything else — including the config import below, which
  // is dynamic specifically so this path never triggers it. config.ts
  // searches for and reads an env file as a module-level side effect the
  // moment it's imported, so a static import of it anywhere in this file
  // would run that search (and log a line about it) on every `--version`
  // invocation too. Importing it lazily, only once we know we're not just
  // printing the version, keeps `--version` from touching config loading,
  // the Hub connection, or anything else in this file.
  if (process.argv.includes("--version") || process.argv.includes("-v")) {
    console.log(VERSION);
    process.exit(0);
  }

  const { loadSpokeConfig } = await import("../config.js");
  const config = loadSpokeConfig();
  acquireSingleInstanceLock(config.hubUrl);
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
