import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

export interface IssuedToken {
  token: string;
  name: string;
  /** The only Slack user ID this token may register as — closes off a
   * hijacking path where any token holder could register as (and take over
   * the live connection of) any other owner. */
  ownerUserId: string;
  issuedAt: string;
}

const DEFAULT_STORE_PATH = join(homedir(), ".cctag-hub", "tokens.json");

/**
 * The Hub's registry of tokens it will accept from connecting Spokes. Each
 * token is bound to one Slack user ID at issue time — a token can only
 * register as its own owner, so tokens should still only be handed to
 * people you trust, but a stolen or misused token can't be used to
 * impersonate someone else's connection.
 */
export class TokenStore {
  private tokens = new Map<string, IssuedToken>();

  constructor(private readonly path: string = DEFAULT_STORE_PATH) {
    this.load();
  }

  private load(): void {
    this.tokens.clear();
    try {
      const raw = readFileSync(this.path, "utf8");
      const list = JSON.parse(raw) as IssuedToken[];
      for (const t of list) this.tokens.set(t.token, t);
    } catch {
      // no store yet
    }
  }

  private save(): void {
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true });
    try {
      chmodSync(dir, 0o700);
    } catch {
      // best-effort — directory may be owned by another user in unusual setups
    }
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify([...this.tokens.values()], null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
    try {
      chmodSync(this.path, 0o600);
    } catch {
      // best-effort, see above
    }
  }

  issue(name: string, ownerUserId: string): IssuedToken {
    const token = randomBytes(24).toString("base64url");
    const entry: IssuedToken = { token, name, ownerUserId, issuedAt: new Date().toISOString() };
    this.tokens.set(token, entry);
    this.save();
    return entry;
  }

  revoke(name: string): boolean {
    let removed = false;
    for (const [token, entry] of this.tokens) {
      if (entry.name === name) {
        this.tokens.delete(token);
        removed = true;
      }
    }
    if (removed) this.save();
    return removed;
  }

  /**
   * Re-reads the store from disk before checking — `token issue`/`revoke`
   * typically run as a separate CLI invocation while the server keeps
   * running, so an in-memory-only check would require a server restart to
   * see newly issued or revoked tokens.
   */
  validate(token: string): IssuedToken | undefined {
    this.load();
    return this.tokens.get(token);
  }

  /** Whether any token is bound to this Slack user. Re-reads the store, as validate does. */
  hasOwner(ownerUserId: string): boolean {
    this.load();
    for (const t of this.tokens.values()) if (t.ownerUserId === ownerUserId) return true;
    return false;
  }

  list(): IssuedToken[] {
    return [...this.tokens.values()];
  }
}
