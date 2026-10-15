import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { notConnectedText } from "./not-connected.js";
import { TokenStore } from "./tokenStore.js";

test("someone never issued a token is told to register, not to restart a daemon", () => {
  const text = notConnectedText(false);
  assert.match(text, /利用登録がありません/);
  assert.match(text, /spoke-setup\.md/);
  assert.doesNotMatch(text, /デーモン/);
});

test("someone with a token whose Spoke is not connected keeps the daemon notice", () => {
  assert.match(notConnectedText(true), /spokeデーモンが起動しているか/);
});

test("the token store says whether a user was ever issued a token, reading what the CLI wrote", () => {
  const dir = mkdtempSync(join(tmpdir(), "cctag-tokens-"));
  try {
    const path = join(dir, "tokens.json");
    const hub = new TokenStore(path);
    assert.equal(hub.hasOwner("U1"), false);
    new TokenStore(path).issue("alice", "U1"); // `token issue` runs as a separate process
    assert.equal(hub.hasOwner("U1"), true);
    assert.equal(hub.hasOwner("U2"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
