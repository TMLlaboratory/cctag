import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { config as loadDotenv } from "dotenv";
import type { AttachmentLimits } from "./attachments.js";

function xdgConfigHome(): string {
  return process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
}

/**
 * The single-instance default config location for a binary-distributed
 * install (`brew install cctag`, run `cctag-spoke` from anywhere) — and the
 * only path this file will ever auto-scaffold a template into (see
 * writeConfigTemplateAndExit below). Follows the XDG base-dir convention,
 * since a single compiled binary has no repository checkout to hold a
 * `.env.example` next to.
 */
const DEFAULT_CONFIG_PATH = join(xdgConfigHome(), "cctag", "config.env");

/**
 * Picks the first candidate that exists, in order — never merges multiple
 * sources, so behavior stays predictable. A free function (not inlined
 * below) so the precedence itself — path 1 beats path 2 beats path 3 — is
 * testable against fake candidates/exists() without touching the real
 * filesystem or environment.
 */
export function resolveEnvFile(candidates: Array<string | undefined>, exists: (path: string) => boolean): string | undefined {
  for (const candidate of candidates) {
    if (candidate && exists(candidate)) return candidate;
  }
  return undefined;
}

/**
 * CCTAG_ENV_FILE is the one candidate someone sets on purpose, expecting
 * exactly that file to be read — unlike the XDG default / cwd fallback,
 * which are ambient (raised in review on PR #6). Falling back past a typo'd
 * or moved CCTAG_ENV_FILE would be worse than erroring: on a machine
 * running one Spoke per Slack workspace via CCTAG_ENV_FILE (see the
 * search-order comment below), that fallback can silently start an instance
 * against the wrong workspace's credentials instead of failing loudly.
 *
 * Treats an empty string the same as unset (`path &&`, not `path !==
 * undefined`): `CCTAG_ENV_FILE=` is the shell idiom for clearing a variable
 * back to its default for one invocation, and every other candidate in this
 * file (see resolveEnvFile above) already treats an empty value as absent.
 * Without this, that idiom would throw instead of falling back, the one
 * case this function exists to NOT do.
 */
export function assertExplicitEnvFileExists(path: string | undefined, exists: (path: string) => boolean): void {
  if (path && !exists(path)) {
    throw new Error(
      `CCTAG_ENV_FILE is set to "${path}", but that file does not exist. ` +
        "Fix the path, or unset CCTAG_ENV_FILE to fall back to the XDG config / cwd defaults.",
    );
  }
}

// Fixed, cwd-independent search order — read the FIRST match only. This
// exists so a single-binary install finds its config without either failing
// outright or silently reading an unrelated `.env` from whatever directory
// the process happened to be started in.
//
// 1. CCTAG_ENV_FILE, if set — unchanged meaning: the explicit override that
//    lets one machine run multiple instances from a single checkout (see
//    the namespacing this enables at src/hub/index.ts's tokenStorePath and
//    src/spoke/index.ts's pairingStorePathFor). Unlike paths 2 and 3, a set
//    CCTAG_ENV_FILE that doesn't exist is an error, not a fallthrough — see
//    assertExplicitEnvFileExists above.
// 2. ~/.config/cctag/config.env (XDG_CONFIG_HOME-aware) — the new
//    single-instance default for a binary-distributed install.
// 3. ./.env (relative to cwd) — today's default, unchanged: this is what
//    keeps `cp .env.example .env && npm run dev` working from a checkout.
//
// Finding zero of these is explicitly NOT an error by itself — the
// production Hub runs under systemd with `EnvironmentFile=`, which injects
// variables straight into the real process environment and correctly has no
// env file on disk at all. See required() below for what happens next.
const cctagEnvFile = process.env.CCTAG_ENV_FILE;
const xdgConfigPath = DEFAULT_CONFIG_PATH;
const cwdEnvPath = join(process.cwd(), ".env");

assertExplicitEnvFileExists(cctagEnvFile, existsSync);
const loadedEnvPath = resolveEnvFile([cctagEnvFile, xdgConfigPath, cwdEnvPath], existsSync);
if (loadedEnvPath) {
  loadDotenv({ path: loadedEnvPath });
  console.log(`[config] read env file: ${loadedEnvPath}`);
} else {
  // Not an error — see the search-order comment above. required() below is
  // what actually decides whether this matters.
  console.log("[config] no env file found in any search path");
}

/**
 * Names all 3 search locations and states which one (if any) was actually
 * read, path-only, for a missing-variable error message.
 */
function describeSearchPaths(): string {
  const entries: Array<[string, string | undefined]> = [
    ["$CCTAG_ENV_FILE", cctagEnvFile],
    ["~/.config/cctag/config.env", xdgConfigPath],
    ["./.env", cwdEnvPath],
  ];
  const described = entries
    .map(([label, path]) => {
      if (!path) return `${label} (not set)`;
      return path === loadedEnvPath ? `${label} (${path}) [read]` : `${label} (${path}, not read)`;
    })
    .join(", ");
  return loadedEnvPath ? described : `${described} — none read`;
}

/**
 * Every key required() is ever asked for, across every mode (standalone,
 * Spoke, Hub) — the single source of truth for the auto-scaffolded
 * template's contents, and for the test asserting the template doesn't
 * drift from what's actually required. Not every key here is required by
 * every mode (e.g. a Spoke never checks SLACK_BOT_TOKEN); the template is
 * one file covering all three, same as .env.example.
 */
export const REQUIRED_ENV_KEYS = [
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "CCTAG_OWNER_USER_ID",
  "CCTAG_HUB_URL",
  "CCTAG_SPOKE_TOKEN",
] as const;

/**
 * Embedded as a string constant, not read from .env.example at runtime: a
 * `bun --compile` single binary (scripts/build-native.sh) has no repository
 * checkout, so .env.example won't exist on the machine running it. Every
 * key in REQUIRED_ENV_KEYS must appear here — enforced by a test in
 * config.test.ts — since a template missing one would still crash with
 * "Missing required environment variable" right after telling the user
 * they were done.
 */
export const CONFIG_TEMPLATE = `# cctag config — fill in the values below and re-run.
# These come from whoever operates the Hub/Slack app, not from this machine.

# --- Standalone / Hub mode ---
# Slack app credentials (Socket Mode) — see manifest.yaml for the app manifest.
SLACK_BOT_TOKEN=
SLACK_APP_TOKEN=

# Slack user ID of the cctag owner (only this user may run connect/disconnect).
CCTAG_OWNER_USER_ID=

# --- Spoke mode ---
# Ask your Hub operator for these. CCTAG_OWNER_USER_ID above is shared with
# standalone/Hub mode.
CCTAG_HUB_URL=
CCTAG_SPOKE_TOKEN=
`;

/**
 * Fires in exactly one case: a required variable is missing AND no config
 * file was found anywhere (loadedEnvPath is undefined — see required()'s
 * caller). Never touches an existing file (that path never reaches here:
 * an existing-but-incomplete file means loadedEnvPath is set, so
 * required() throws instead), and never fires just because no file was
 * found (the systemd Hub case: required() returns early when the real
 * process environment already has the value, so this is never called).
 */
function writeConfigTemplateAndExit(missingVarName: string): never {
  mkdirSync(dirname(DEFAULT_CONFIG_PATH), { recursive: true });
  writeFileSync(DEFAULT_CONFIG_PATH, CONFIG_TEMPLATE, { mode: 0o600 });
  try {
    chmodSync(DEFAULT_CONFIG_PATH, 0o600); // belt-and-suspenders against umask — see tokenStore.ts's save()
  } catch {
    /* best-effort — directory may be owned by another user in unusual setups */
  }
  console.log(
    `[config] ${missingVarName} is not set. Searched (in order): ${describeSearchPaths()}. ` +
      `Wrote a starting template to ${DEFAULT_CONFIG_PATH} (mode 0600).\n` +
      `Fill in the values there (ask whoever operates your Hub/Slack app for them) and run this again.`,
  );
  process.exit(1);
}

function required(name: string): string {
  const v = process.env[name];
  if (v) return v;
  if (!loadedEnvPath) {
    // No config file exists anywhere AND a required variable is missing —
    // the one case this file auto-scaffolds. See writeConfigTemplateAndExit's
    // doc comment for why "no file found" alone is not enough on its own.
    writeConfigTemplateAndExit(name);
  }
  throw new Error(
    `Missing required environment variable: ${name}. Searched (in order): ${describeSearchPaths()}.`,
  );
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
