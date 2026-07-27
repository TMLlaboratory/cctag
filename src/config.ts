import { config as loadDotenv } from "dotenv";
import type { AttachmentLimits } from "./attachments.js";

// Lets one machine run multiple instances (e.g. one Spoke per Slack
// workspace) from a single checkout: point CCTAG_ENV_FILE at a different
// .env per instance (set it in that instance's launchd plist / systemd unit
// / wrapper script — it must come from the real process environment, not
// from a .env file, since it decides which .env file to load).
loadDotenv(process.env.CCTAG_ENV_FILE ? { path: process.env.CCTAG_ENV_FILE } : undefined);

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

/**
 * Caps on files moved in either direction. Both directions share one pair of
 * knobs on purpose — the binding constraint is the same either way: in
 * Hub–Spoke mode every file crosses the WebSocket RPC base64-encoded (~1.37x
 * its byte size) inside a single JSON message.
 */
function loadAttachmentConfig(): AttachmentLimits {
  return {
    maxFileBytes: Number(process.env.CCTAG_MAX_FILE_MB ?? 8) * 1024 * 1024,
    maxFileCount: Number(process.env.CCTAG_MAX_FILE_COUNT ?? 5),
  };
}

/** Config for standalone mode: a single machine talks to Slack directly. */
export interface Config extends AttachmentLimits {
  slackBotToken: string;
  slackAppToken: string;
  ownerUserId: string;
  herdrBin: string;
  turnTimeoutMs: number;
  pollIntervalMs: number;
}

export function loadConfig(): Config {
  return {
    slackBotToken: required("SLACK_BOT_TOKEN"),
    slackAppToken: required("SLACK_APP_TOKEN"),
    ownerUserId: required("CCTAG_OWNER_USER_ID"),
    herdrBin: process.env.CCTAG_HERDR_BIN ?? "/opt/homebrew/bin/herdr",
    turnTimeoutMs: Number(process.env.CCTAG_TURN_TIMEOUT_MS ?? 1_200_000),
    pollIntervalMs: Number(process.env.CCTAG_POLL_INTERVAL_MS ?? 1_500),
    ...loadAttachmentConfig(),
  };
}

/** Config for Spoke mode: runs on a user's machine, connects out to a Hub. Does NOT talk to Slack directly. */
export interface SpokeConfig extends AttachmentLimits {
  ownerUserId: string;
  herdrBin: string;
  turnTimeoutMs: number;
  pollIntervalMs: number;
  hubUrl: string;
  spokeToken: string;
}

export function loadSpokeConfig(): SpokeConfig {
  return {
    ownerUserId: required("CCTAG_OWNER_USER_ID"),
    herdrBin: process.env.CCTAG_HERDR_BIN ?? "/opt/homebrew/bin/herdr",
    turnTimeoutMs: Number(process.env.CCTAG_TURN_TIMEOUT_MS ?? 1_200_000),
    pollIntervalMs: Number(process.env.CCTAG_POLL_INTERVAL_MS ?? 1_500),
    hubUrl: required("CCTAG_HUB_URL"),
    spokeToken: required("CCTAG_SPOKE_TOKEN"),
    ...loadAttachmentConfig(),
  };
}

/** Config for Hub mode: holds the one Slack Socket Mode connection, routes to Spokes over WebSocket. */
export interface HubConfig extends AttachmentLimits {
  slackBotToken: string;
  slackAppToken: string;
  wsPort: number;
}

export function loadHubConfig(): HubConfig {
  return {
    slackBotToken: required("SLACK_BOT_TOKEN"),
    slackAppToken: required("SLACK_APP_TOKEN"),
    wsPort: Number(process.env.CCTAG_HUB_PORT ?? 8765),
    ...loadAttachmentConfig(),
  };
}
