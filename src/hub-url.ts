// Two ways of naming a Hub, kept in one file with no side effects on
// purpose. Both used to live elsewhere — `wsUrlFor` in spoke/index.ts,
// `hubSlug` in config.ts — and drifted out of sync (moiku, PR #4 review):
// `wsUrlFor` stripped a trailing slash before connecting, `hubSlug` hashed
// the raw string, so "https://hub" and "https://hub/" pointed at the same
// Hub but got different lock files and pairing stores. Co-locating them
// makes that invariant ("both derive from the same normalized URL")
// visible instead of implicit.
//
// No side effects matters here for a second reason: config.ts loads and
// validates the env file as a module-level side effect the moment it's
// imported (see config.ts's top-of-file comment) — a guarantee `--version`
// depends on never firing (see spoke/index.ts's main()). `hubSlug` used to
// live in config.ts, so anything needing it — like spoke/lock.ts — had no
// choice but to statically import config.ts, defeating that guarantee the
// instant lock.ts was imported, `--version` or not. Moving it to its own
// module with nothing at module scope lets lock.ts (and spoke/index.ts)
// import it for free.

/** Normalizes a Hub URL for the actual WebSocket connection. */
export function wsUrlFor(hubUrl: string): string {
  return hubUrl.replace(/\/+$/, "") + "/spoke";
}

/**
 * Turns a Hub URL into a filename-safe token, so per-Hub state living in
 * `~/.cctag/` (pairing store, single-instance lock, ...) can be namespaced
 * without extra config. Shared by every such file on purpose: the names are
 * effectively a persisted format, so the sanitizing rule must stay in one
 * place rather than being re-derived (and drifting) at each call site.
 *
 * Strips a trailing slash before slugging, matching `wsUrlFor` above:
 * without this, "https://hub" and "https://hub/" — the same Hub — would
 * slug to different tokens and get separate lock files and pairing stores,
 * reproducing the exact two-Spokes-fighting-each-other failure this
 * namespacing exists to prevent.
 */
export function hubSlug(hubUrl: string): string {
  return hubUrl.replace(/\/+$/, "").replace(/[^a-zA-Z0-9]/g, "-");
}
