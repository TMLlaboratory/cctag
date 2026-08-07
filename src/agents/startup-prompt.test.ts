import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCodexStartupPrompt } from "./codex/prompts.js";
import { parseClaudeStartupPrompt } from "./claude/prompts.js";
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

// Captured verbatim from Codex CLI 0.146.1 on startup with an update pending.
// The selected option runs brew — submitting into this upgraded the binary
// under a live session, which is why the detector can't be a list of known
// dialogs.
const CODEX_UPDATE = [
  "  ✨ Update available! 0.146.1 -> 0.147.0",
  "  Release notes: https://github.com/openai/codex/releases/latest",
  "› 1. Update now (runs `brew upgrade --cask codex`)",
  "  2. Skip",
  "  3. Skip until next version",
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
  " Enter to confirm · Esc to cancel",
].join("\n");

// A settled pane: banner, no pending dialog. Must not be treated as waiting.
const CODEX_IDLE = [
  "╭────────────────────────────────────╮",
  "│ >_ OpenAI Codex (v0.147.0)         │",
  "│ model:     gpt-5.6-sol high        │",
  "╰────────────────────────────────────╯",
  "• You have 1 usage limit reset available. Run /usage to use one.",
  "› Run /review on my current changes",
].join("\n");

test("the Codex directory-trust dialog is detected", () => {
  assert.equal(parseCodexStartupPrompt(CODEX_TRUST), "Do you trust the contents of this directory?");
});

test("the Codex update dialog is detected, and says the default runs brew", () => {
  const got = parseCodexStartupPrompt(CODEX_UPDATE);
  assert.ok(got, "must not be null — submitting here upgrades the binary");
  assert.match(got, /Update available/);
  assert.match(got, /brew upgrade/, "the consequence of the default option has to be visible");
});

test("the Claude Code folder-trust dialog is detected", () => {
  assert.equal(parseClaudeStartupPrompt(CLAUDE_TRUST), "Is this a project you created or one you trust?");
});

test("a settled pane with no pending dialog is not treated as waiting", () => {
  assert.equal(parseCodexStartupPrompt(CODEX_IDLE), null);
  assert.equal(parseClaudeStartupPrompt(CODEX_IDLE), null);
});

test("an unknown startup dialog is still caught, quoting its headline", () => {
  // The point of being shape-based: a dialog nobody has seen yet must not slip
  // through just because its wording isn't in the code.
  const future = [
    "  Some brand new question we have never seen?",
    "› 1. Do the thing",
    "  2. Cancel",
    "  Press enter to confirm",
  ].join("\n");
  assert.equal(parseCodexStartupPrompt(future), "Some brand new question we have never seen?");
});

test("options without an enter-to-continue footer are not treated as waiting", () => {
  // Numbered lines alone aren't a dialog — agents print lists all the time.
  const list = ["  手順は次の通りです", "› 1. まず準備する", "  2. 次に実行する"].join("\n");
  assert.equal(parseCodexStartupPrompt(list), null);
});

test("both drivers expose the detector, so startTurn covers either agent", () => {
  assert.equal(typeof codexDriver.parseStartupPrompt, "function");
  assert.equal(typeof claudeDriver.parseStartupPrompt, "function");
  assert.notEqual(codexDriver.parseStartupPrompt!(CODEX_UPDATE), null);
  assert.notEqual(claudeDriver.parseStartupPrompt!(CLAUDE_TRUST), null);
});
