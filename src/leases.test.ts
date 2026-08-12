import { test } from "node:test";
import assert from "node:assert/strict";
import { PaneLeaseRegistry } from "./leases.js";

const PANE = "wL:p1";

test("a pane can only be held by one thing at a time", () => {
  const leases = new PaneLeaseRegistry();
  const first = leases.tryAcquire(PANE, "turn");
  assert.ok(first);
  assert.equal(leases.tryAcquire(PANE, "model-command"), null);
  assert.equal(leases.reasonFor(PANE), "turn", "the message can name what has it");

  first.release();
  assert.equal(leases.isHeld(PANE), false);
  assert.ok(leases.tryAcquire(PANE, "model-command"), "released panes are available again");
});

test("releasing a superseded lease does not evict the current holder", () => {
  // The failure mode this replaces: ownership was a plain Set, so whichever
  // operation finished first deleted the entry and the pane looked free while
  // another was still driving its TUI.
  const leases = new PaneLeaseRegistry();
  const stale = leases.tryAcquire(PANE, "first");
  assert.ok(stale);
  stale.release();

  const current = leases.tryAcquire(PANE, "second");
  assert.ok(current);
  stale.release(); // late, duplicated release from the finished operation
  assert.equal(leases.isHeld(PANE), true, "the second holder must keep the pane");
  assert.equal(leases.reasonFor(PANE), "second");
});

test("cancel signals the holder but leaves it to let go itself", () => {
  // The holder is the one that knows when releasing is safe — mid-upload,
  // mid-prompt — so cancellation must not take the pane out from under it.
  const leases = new PaneLeaseRegistry();
  const lease = leases.tryAcquire(PANE, "turn");
  assert.ok(lease);
  assert.equal(lease.cancelled, false);

  assert.equal(leases.cancel(PANE), true);
  assert.equal(lease.cancelled, true);
  assert.equal(lease.signal.aborted, true, "the signal is what a poll loop waits on");
  assert.equal(leases.isHeld(PANE), true, "still held until the holder releases");

  lease.release();
  assert.equal(leases.isHeld(PANE), false);
});

test("cancelling an unheld pane reports that there was nothing to cancel", () => {
  const leases = new PaneLeaseRegistry();
  assert.equal(leases.cancel(PANE), false);
});

test("cancelAll signals every holder and counts them", () => {
  const leases = new PaneLeaseRegistry();
  const a = leases.tryAcquire("w1:p1", "turn");
  const b = leases.tryAcquire("w2:p1", "turn");
  assert.ok(a && b);

  assert.equal(leases.cancelAll(), 2);
  assert.equal(a.cancelled, true);
  assert.equal(b.cancelled, true);
});
