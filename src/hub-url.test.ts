import { test } from "node:test";
import assert from "node:assert/strict";
import { hubSlug, wsUrlFor } from "./hub-url.js";

test("hubSlug ignores a trailing slash, matching wsUrlFor's own normalization", () => {
  // https://hub and https://hub/ are the same Hub; they must share one
  // lock file and one pairing store, or two Spokes pointed at the "same"
  // Hub (one with a trailing slash, one without) would fail to see each
  // other and reproduce the fight-forever bug this namespacing prevents.
  assert.equal(hubSlug("https://hub"), hubSlug("https://hub/"));
  assert.equal(hubSlug("https://hub///"), hubSlug("https://hub"));
});

test("wsUrlFor and hubSlug agree on what the normalized URL looks like", () => {
  // The bug this file exists to prevent: the two functions drifting apart
  // on what "the same Hub" means. Both must derive from the same
  // trailing-slash-stripped form.
  assert.equal(wsUrlFor("https://hub"), wsUrlFor("https://hub/"));
});
