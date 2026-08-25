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
 * Parses a numeric env var, refusing anything that wouldn't behave as a limit.
 *
 * `Number()` alone is not enough for values that guard a resource boundary:
 * `Number("8MB")` is NaN, and every `size > NaN` comparison is false, so a typo
 * silently removes the cap it was meant to tighten. An empty value is treated
 * as unset rather than as 0, since `Number("")` is 0 and a 0-byte cap would
 * reject every file instead of obviously failing.
 *
 * "Positive and finite" is necessary but not sufficient, hence `min`/`max`:
 * every one of these knobs has a domain outside which a *technically valid*
 * number still misbehaves silently rather than loudly. A poll interval of 0.5
 * becomes a millisecond-scale hot loop against herdr; any delay above 2^31-1 is
 * coerced by Node to 1ms, so an absurdly long interval acts like the shortest
 * possible one; a port over 65535 fails at listen() long after config load; and
 * a file cap of 1e308 passes here but overflows to Infinity once multiplied
 * into bytes, disabling the comparison it exists for. Callers state the real
 * domain so the value is rejected at startup with its own name attached.
 */
export function parsePositiveNumber(
  name: string,
  fallback: number,
  opts: { integer?: boolean; min?: number; max?: number } = {},
): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, got "${raw}"`);
  }
  if (opts.integer && !Number.isInteger(value)) {
    throw new Error(`${name} must be a whole number, got "${raw}"`);
  }
  if (opts.min !== undefined && value < opts.min) {
    throw new Error(`${name} must be at least ${opts.min}, got "${raw}"`);
  }
  if (opts.max !== undefined && value > opts.max) {
    throw new Error(`${name} must be at most ${opts.max}, got "${raw}"`);
  }
  return value;
}

/** Largest value Node's timers accept before coercing the delay to 1ms. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Caps on files moved in either direction. Both directions share one pair of
 * knobs on purpose — the binding constraint is the same either way: in
 * Hub–Spoke mode every file crosses the WebSocket RPC base64-encoded (~1.37x
 * its byte size) inside a single JSON message.
 *
 * The 10MB default is bounded by Hub memory, not by Slack (which allows 1GB)
 * or by the WebSocket layer (`ws` defaults to a 100MiB message cap). Nothing
 * streams: one transfer holds the frame buffer, its string form, the parsed
 * base64, and the decoded bytes at once — roughly 6x the file size, so ~60MB
 * of transient allocation here. Measured against the free-tier VM the Hub
 * actually runs on (954MB total, no swap, ~445MB available), that leaves room
 * for several concurrent transfers; raising this much further would not.
 */
function loadAttachmentConfig(): AttachmentLimits {
  return {
    // Capped at Slack's own 1GB per-file limit: anything past it could not be
    // delivered anyway, and it keeps the MB->bytes multiply below well clear of
    // the overflow that would turn the cap into Infinity.
    maxFileBytes: parsePositiveNumber("CCTAG_MAX_FILE_MB", 10, { max: 1024 }) * 1024 * 1024,
    maxFileCount: parsePositiveNumber("CCTAG_MAX_FILE_COUNT", 5, { integer: true, max: 100 }),
  };
}

/**
 * The two turn-loop timings, shared by standalone and Spoke mode.
 *
 * Validated for the same reason the file caps are, and with more at stake: both
 * names end in `_MS`, which invites writing the unit in the value ("20m",
 * "1.5s"). `Number()` turns that into NaN, and NaN fails silently in the
 * direction that removes the safeguard — `elapsed > NaN` is always false, so
 * the turn never times out, and `setTimeout(NaN)` fires after 1ms, turning the
 * poll loop into a hot loop against herdr (both measured, not inferred).
 */
function loadTimingConfig(): { turnTimeoutMs: number; pollIntervalMs: number } {
  return {
    turnTimeoutMs: parsePositiveNumber("CCTAG_TURN_TIMEOUT_MS", 1_200_000, {
      integer: true,
      min: 1_000,
      max: MAX_TIMER_MS,
    }),
    // The floor is what keeps a plausible-looking "0.5" from becoming a
    // millisecond-scale hot loop spawning herdr processes.
    pollIntervalMs: parsePositiveNumber("CCTAG_POLL_INTERVAL_MS", 1_500, {
      integer: true,
      min: 100,
      max: MAX_TIMER_MS,
    }),
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
    ...loadTimingConfig(),
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
    ...loadTimingConfig(),
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
    wsPort: parsePositiveNumber("CCTAG_HUB_PORT", 8765, { integer: true, min: 1, max: 65_535 }),
    ...loadAttachmentConfig(),
  };
}
