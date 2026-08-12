/**
 * Exclusive ownership of a pane, held for as long as something is driving it.
 *
 * Three independent things reach for the same pane, and two of them run on
 * timers nobody controls: Slack events (a message, a button, a thread reply),
 * BackgroundWatcher's tick, and a turn's own poll loop. Ownership used to be
 * three separate collections behind one `isBusy()` — which answered *whether*
 * a pane was taken but never *by whom*, so every caller had to check and then
 * claim in two steps with `await`s in between. Anything arriving in that gap
 * passed the same check and drove the same pane; and because the marker was a
 * plain Set, whichever operation finished first freed a pane the other was
 * still using.
 *
 * A lease fixes both by being a token: it is acquired in one synchronous step
 * (JavaScript runs the whole function without interleaving, which is all the
 * atomicity needed here), it identifies its holder, and `release()` from anyone
 * else is a no-op. Holders that `await` re-check `cancelled` afterwards rather
 * than assuming they still own what they claimed.
 */
export interface PaneLease {
  readonly paneId: string;
  /** What took it, for the "busy" message and for logs. */
  readonly reason: string;
  /** Set when someone asked this work to stop — `disconnect`, or shutdown. */
  readonly cancelled: boolean;
  /** Aborts with the lease, so a poll loop can wait on it directly. */
  readonly signal: AbortSignal;
  /** Gives the pane back. Safe to call twice, and a no-op once superseded. */
  release(): void;
}

class Lease implements PaneLease {
  private readonly controller = new AbortController();
  private released = false;

  constructor(
    readonly paneId: string,
    readonly reason: string,
    private readonly onRelease: (lease: Lease) => void,
  ) {}

  get cancelled(): boolean {
    return this.controller.signal.aborted;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  cancel(): void {
    if (!this.controller.signal.aborted) this.controller.abort();
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.onRelease(this);
  }
}

export class PaneLeaseRegistry {
  private held = new Map<string, Lease>();

  /**
   * Takes the pane, or returns null if something already has it. Synchronous on
   * purpose — the whole point is that no `await` sits between the test and the
   * claim.
   */
  tryAcquire(paneId: string, reason: string): PaneLease | null {
    if (this.held.has(paneId)) return null;
    const lease = new Lease(paneId, reason, (l) => {
      // Only if still the holder: a lease released after being superseded must
      // not evict whoever legitimately owns the pane now.
      if (this.held.get(paneId) === l) this.held.delete(paneId);
    });
    this.held.set(paneId, lease);
    return lease;
  }

  isHeld(paneId: string): boolean {
    return this.held.has(paneId);
  }

  /** What currently holds the pane, for a more useful "busy" message. */
  reasonFor(paneId: string): string | undefined {
    return this.held.get(paneId)?.reason;
  }

  /**
   * Asks the holder to stop, without taking the pane away: the holder is the
   * one that knows when it is safe to let go (mid-upload, mid-prompt), so it
   * still releases in its own `finally`. Returns false if nothing held it.
   */
  cancel(paneId: string): boolean {
    const lease = this.held.get(paneId);
    if (!lease) return false;
    lease.cancel();
    return true;
  }

  /** Cancels every lease, for shutdown. Returns how many were signalled. */
  cancelAll(): number {
    const leases = [...this.held.values()];
    for (const lease of leases) lease.cancel();
    return leases.length;
  }
}
