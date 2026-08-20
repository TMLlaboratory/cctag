import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { hubSlug } from "../config.js";

/**
 * A second Spoke for the same owner is never harmless: the Hub keeps only the
 * newest connection per owner and closes the previous one on register, and
 * both Spokes reconnect on close — so the two kick each other off forever, in
 * a tight loop. (This actually happened.) The Hub can't defend against it
 * without also rejecting legitimate reconnects whose old socket is still
 * lingering after a network drop, so the guard has to live here, locally,
 * where "am I already running?" is answerable.
 *
 * One lock per Hub URL rather than one per machine: running a Spoke per Slack
 * workspace from the same checkout is a supported setup (see CCTAG_ENV_FILE
 * in config.ts), and those instances don't conflict.
 */
export function acquireSingleInstanceLock(hubUrl: string): void {
  const path = join(homedir(), ".cctag", `spoke-${hubSlug(hubUrl)}.lock`);
  mkdirSync(dirname(path), { recursive: true });

  if (!tryCreate(path)) {
    const holder = livePidIn(path);
    if (holder !== undefined) {
      throw new Error(
        `another cctag-spoke (pid ${holder}) is already connected to ${hubUrl}. ` +
          "The Hub keeps only the newest connection per owner, so a second Spoke would " +
          "get the first one disconnected and the two would fight to reconnect forever. " +
          `Stop the running Spoke first, or delete ${path} if you are sure it is stale.`,
      );
    }
    // Left behind by a Spoke that was killed hard (SIGKILL, power loss, ...).
    // Clearing it is safe precisely because no live process holds it; the
    // retry can still lose to another starting Spoke, in which case we fail
    // with the message above rather than steal the lock.
    unlinkSync(path);
    if (!tryCreate(path)) {
      throw new Error(
        `another cctag-spoke just claimed the lock for ${hubUrl} (${path}). ` +
          "Two Spokes were started at almost the same moment; only one may run.",
      );
    }
  }

  const owned = String(process.pid);
  process.on("exit", () => {
    // Only remove a lock that is still ours. If we were considered stale and
    // another Spoke took over, the file now holds its pid — deleting it would
    // silently disarm the guard for the process that is actually running.
    try {
      if (readFileSync(path, "utf8").trim() === owned) unlinkSync(path);
    } catch {
      // Already gone, or unreadable — nothing useful to do while exiting.
    }
  });
  // Default signal termination kills the process without emitting "exit", so
  // the handler above would never run and every Ctrl-C would leave a stale
  // lock behind. Re-enter through process.exit() to get it. Nothing else is
  // added here on purpose: this must not change how the Spoke shuts down.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => process.exit());
  }
}

/** Creates the lock file exclusively and stamps our pid into it. */
function tryCreate(path: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, "wx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err; // permission error, missing home dir, ... — surface it
  }
  try {
    writeSync(fd, String(process.pid));
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * Returns the pid recorded in the lock file if that process is still alive,
 * or undefined if the lock is stale (unreadable, empty, garbage, or naming a
 * pid that no longer exists). Anything we can't confirm as live is treated as
 * stale: refusing to start over an unparseable file would be a worse failure
 * than the race it would prevent.
 */
function livePidIn(path: string): number | undefined {
  let pid: number;
  try {
    pid = Number(readFileSync(path, "utf8").trim());
  } catch {
    return undefined;
  }
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    process.kill(pid, 0); // signal 0 only probes existence
    return pid;
  } catch (err) {
    // EPERM means the pid exists but belongs to another user — still alive,
    // so still a conflict. Only ESRCH ("no such process") proves it's gone.
    return (err as NodeJS.ErrnoException).code === "EPERM" ? pid : undefined;
  }
}
