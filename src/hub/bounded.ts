/**
 * An insertion-ordered Map capped at a fixed size, for the Hub's long-lived
 * lookup tables.
 *
 * Its own module so it can be tested: hub/index.ts runs `main()` at import, so
 * a test importing anything from it starts a real server and hangs.
 */

/**
 * Sets `key`, then drops the oldest entries until `map` holds at most `max`.
 *
 * Map iteration is insertion-ordered, so "oldest" is the first key. Re-setting
 * an existing key keeps its original position — fine for tables whose keys are
 * written once.
 */
export function setBounded<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}
