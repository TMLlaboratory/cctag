import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Pairing {
  key: string; // `${channel}:${threadTs}` for thread pairings, `${channel}` for channel pairings
  channel: string;
  threadTs?: string;
  // The herdr target used for every agent-level call (get/send-keys/prompt).
  // herdr 0.7.5 dropped terminal_id as a valid agent target — only a unique
  // agent name or its hosting pane id resolve now — so paneId is the
  // functional identity going forward. It's also more durable than
  // terminalId: a pane's id doesn't change when the CLI running inside it
  // restarts, so a pairing survives a Claude Code/Codex restart in place.
  paneId: string;
  // Display/debug only, snapshotted at pairing time — never used to address
  // herdr (see paneId). A pane whose occupant restarts gets a new terminalId,
  // so this can go stale; that's fine, it's cosmetic.
  terminalId: string;
  cwd: string; // display only, snapshotted at pairing time
  // Display/help-text only, snapshotted at pairing time (e.g. "claude" | "codex").
  // Driver selection always comes from a live agentGet() call, never this field —
  // so a pane whose CLI changed after pairing still gets the right driver.
  agent?: string;
  pairedBy: string; // Slack user id of the owner who paired it
  pairedAt: string; // ISO 8601
}

const DEFAULT_STORE_PATH = join(homedir(), ".cctag", "pairings.json");

export type PairingChange = { action: "add" | "remove"; pairing: Pairing };

export class PairingStore {
  private pairings = new Map<string, Pairing>();

  /**
   * Optional hook for Hub–Spoke mode: the Spoke uses this to tell the Hub
   * which thread it now owns (or no longer owns), so the Hub can route
   * future events for that thread to the right Spoke connection without
   * needing its own copy of pairing state.
   */
  onChange?: (change: PairingChange) => void;

  constructor(private readonly path: string = DEFAULT_STORE_PATH) {
    this.load();
  }

  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // no store yet — start empty
      throw err; // permission error, etc. — don't silently start empty and
      // risk the next add()/remove() overwriting a store we couldn't
      // actually read (see: the accidental pairings-wipe incident this
      // guards against)
    }
    const list = JSON.parse(raw) as Pairing[]; // a parse failure should throw loudly, not start empty
    for (const p of list) {
      const missing = PairingStore.missingFields(p);
      if (missing.length > 0) {
        // Entries written before daa33a3 (or otherwise corrupted) may lack
        // paneId — herdr has no terminalId target anymore, so passing one of
        // these through hangs `checkPairing` on `herdr agent get undefined`
        // forever and the thread silently stops getting replies. Drop it
        // from the in-memory map instead of loading it; we deliberately
        // don't rewrite the file here (see save() — this method only reads),
        // so the stale entry stays on disk until the next add()/remove()
        // triggers a save() and it's dropped for good.
        const thread = p?.threadTs ? `${p.channel}:${p.threadTs}` : (p?.channel ?? p?.key ?? "<unknown>");
        console.error(
          `[pairing] dropping invalid pairing for ${thread} (missing: ${missing.join(", ")}). ` +
            `Run /connect again in that Slack thread to fix it.`,
        );
        continue;
      }
      this.pairings.set(p.key, p);
    }
  }

  /** Returns the names of required Pairing fields that are missing or blank on `p`. */
  private static missingFields(p: Pairing): string[] {
    const missing: string[] = [];
    if (typeof p?.key !== "string" || p.key === "") missing.push("key");
    if (typeof p?.channel !== "string" || p.channel === "") missing.push("channel");
    if (typeof p?.paneId !== "string" || p.paneId === "") missing.push("paneId");
    return missing;
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify([...this.pairings.values()], null, 2));
    renameSync(tmp, this.path);
  }

  static threadKey(channel: string, threadTs: string): string {
    return `${channel}:${threadTs}`;
  }

  static channelKey(channel: string): string {
    return channel;
  }

  /** Looks up a pairing for a thread, falling back to a channel-level pairing. */
  get(channel: string, threadTs?: string): Pairing | undefined {
    if (threadTs) {
      const exact = this.pairings.get(PairingStore.threadKey(channel, threadTs));
      if (exact) return exact;
    }
    return this.pairings.get(PairingStore.channelKey(channel));
  }

  byPane(paneId: string): Pairing | undefined {
    for (const p of this.pairings.values()) {
      if (p.paneId === paneId) return p;
    }
    return undefined;
  }

  add(p: Pairing): void {
    const previous = this.pairings.get(p.key);
    this.pairings.set(p.key, p);
    try {
      this.save();
    } catch (err) {
      // Keep in-memory state consistent with what's actually on disk —
      // otherwise a restart would silently revert this "successful" add.
      if (previous) this.pairings.set(p.key, previous);
      else this.pairings.delete(p.key);
      throw err;
    }
    this.onChange?.({ action: "add", pairing: p });
  }

  remove(key: string): boolean {
    const existing = this.pairings.get(key);
    if (!existing) return false;
    this.pairings.delete(key);
    try {
      this.save();
    } catch (err) {
      this.pairings.set(key, existing);
      throw err;
    }
    this.onChange?.({ action: "remove", pairing: existing });
    return true;
  }

  list(): Pairing[] {
    return [...this.pairings.values()];
  }
}
