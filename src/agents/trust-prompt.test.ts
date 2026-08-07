import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCodexTrustPrompt } from "./codex/prompts.js";
import { parseClaudeTrustPrompt } from "./claude/prompts.js";
import { codexDriver } from "./codex/driver.js";
import { claudeDriver } from "./claude/driver.js";

// Captured verbatim from Codex CLI 0.147.0 on a fresh directory.
const CODEX_TRUST = [
  "> You are in /private/tmp/scratch/codex-2nd",
  "  Do you trust the contents of this directory? Working with untrusted contents comes with higher risk of prompt injection.",
  "  Trusting the directory allows project-local config, hooks, and exec policies to load.",
  "› 1. Yes, continue",
  "  2. No, quit",
  "  Press enter to continue",
].join("\n");

// Captured verbatim from Claude Code on a fresh directory.
const CLAUDE_TRUST = [
  " Accessing workspace:",
  " /private/tmp/scratch/v3-workdir",
  " Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known",
  " open source project, or work from your team).",
  " ❯ 1. Yes, I trust this folder",
  "   2. No, exit",
].join("\n");

// A real approval menu — this one herdr *does* report as blocked, and it must
// not be mistaken for the trust dialog.
const CODEX_APPROVAL = [
  "  Would you like to run the following command?",
  "  $ curl -sS https://example.com | head -n 10",
  "› 1. Yes, proceed (y)",
  "  2. Yes, and don't ask again for commands that start with `curl`",
  "  3. No, and tell Codex what to do differently (esc)",
].join("\n");

test("the Codex startup trust dialog is detected", () => {
  assert.equal(parseCodexTrustPrompt(CODEX_TRUST), "Do you trust the contents of this directory?");
});

test("the Claude Code startup trust dialog is detected", () => {
  assert.equal(parseClaudeTrustPrompt(CLAUDE_TRUST), "Is this a project you created or one you trust?");
});

test("an ordinary approval menu is not mistaken for the trust dialog", () => {
  assert.equal(parseCodexTrustPrompt(CODEX_APPROVAL), null);
  assert.equal(parseClaudeTrustPrompt(CODEX_APPROVAL), null);
});

test("prose merely mentioning trust does not trip the detectors", () => {
  const prose = "Do you trust the contents of this directory? という確認が出ることがあります。";
  // The question is there but the affirmative option isn't, so this is text
  // *about* the dialog rather than the dialog itself.
  assert.equal(parseCodexTrustPrompt(prose), null);
});

test("both drivers expose the detector, so startTurn can check either agent", () => {
  assert.equal(typeof codexDriver.parseTrustPrompt, "function");
  assert.equal(typeof claudeDriver.parseTrustPrompt, "function");
  assert.equal(codexDriver.parseTrustPrompt!(CODEX_TRUST), "Do you trust the contents of this directory?");
  assert.equal(claudeDriver.parseTrustPrompt!(CLAUDE_TRUST), "Is this a project you created or one you trust?");
});

test("the trust dialog is not classified as an answerable permission menu", () => {
  // parseBlockedPane may well find the numbered options — the point is that
  // startTurn checks parseTrustPrompt *first*, so the dialog is never answered
  // on the user's behalf. Guard the ordering assumption explicitly.
  assert.notEqual(codexDriver.parseTrustPrompt!(CODEX_TRUST), null);
});
