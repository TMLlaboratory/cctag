import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inspectHcCodexPrompt } from "./prompts.js";
import { codexDriver, parseCodexModelMenuPrompt } from "./driver.js";

// Captured verbatim in D-codex-11a-permissions-menu-restore-screen.json and
// D-codex-11b-after-down-screen.txt; only the cursor moves from row 1 to row 2.
const BEFORE_DOWN = [
  "  Update Model Permissions",
  "› 1. Ask for approval (current)  Read and edit workspace files and run commands, with approval required for internet access or edits outside the workspace",
  "  2. Approve for me              Only ask for actions detected as potentially unsafe",
  "  3. Full Access                 Use with caution: Codex can edit files outside this workspace and access the internet without approval",
  "  enter select · esc back",
].join("\n");
const AFTER_DOWN = [
  "  Update Model Permissions",
  "  1. Ask for approval (current)  Read and edit workspace files and run commands, with approval required for internet access or edits outside the workspace",
  "› 2. Approve for me              Only ask for actions detected as potentially unsafe",
  "  3. Full Access                 Use with caution: Codex can edit files outside this workspace and access the internet without approval",
  "  enter select · esc back",
].join("\n");

const MODEL_MENU = [
  "Select Model and Effort",
  "› 1. GPT-6-Astra",
  "  2. GPT-5.6-sol",
  "Press enter to confirm",
].join("\n");
const EFFORT_MENU = [
  "Select Reasoning Level for GPT-6-Astra",
  "› 1. High",
  "  2. Medium",
  "Press enter to confirm",
].join("\n");

function snapshot(text: string) {
  return { text, draft: null, complete: true };
}

test("Codex cursor labels follow the selected row before and after Down", () => {
  assert.equal(
    codexDriver.parseCursorLabel(snapshot(BEFORE_DOWN)),
    "Ask for approval (current)  Read and edit workspace files and run commands, with approval required for internet access or edits outside the workspace",
  );
  assert.equal(
    codexDriver.parseCursorLabel(snapshot(AFTER_DOWN)),
    "Approve for me              Only ask for actions detected as potentially unsafe",
  );
  assert.equal(codexDriver.parseCursorLabel(snapshot("  1. Yes\n  2. No")), null);
  const prompt = codexDriver.parseBlockedPane(BEFORE_DOWN);
  assert.equal(prompt.kind, "permission");
  if (prompt.kind === "permission") assert.equal(prompt.verified.form, "digit-then-enter");
});

test("only the Codex /model stage parser creates model-menu capabilities", () => {
  assert.equal(codexDriver.modes, null);
  for (const pane of [MODEL_MENU, EFFORT_MENU]) {
    const modelPrompt = parseCodexModelMenuPrompt(pane);
    assert.ok(modelPrompt);
    assert.equal(modelPrompt.capability, "codex-model-menu");
    assert.equal(modelPrompt.form, "digit-then-enter");
  }

  assert.equal(parseCodexModelMenuPrompt(BEFORE_DOWN), null);
  const approval = codexDriver.parseBlockedPane(BEFORE_DOWN);
  assert.equal(approval.kind, "permission");
  if (approval.kind === "permission") {
    assert.equal("capability" in approval.verified, false);
  }
});

test("hc Codex classifies measured prompts without granting capabilities", () => {
  const read = (name: string) => JSON.parse(readFileSync(new URL(`./__fixtures__/hc-${name}.screen.json`, import.meta.url), "utf8")).text;
  const question = inspectHcCodexPrompt(snapshot(read("question")), "question");
  assert.equal(question?.kind, "question");
  const nextQuestion = inspectHcCodexPrompt(snapshot(read("question-next")), "question");
  assert.ok(nextQuestion);
  assert.equal(nextQuestion?.kind, "question");
  assert.notEqual(question?.fingerprint, nextQuestion.fingerprint);
  assert.deepEqual(question, inspectHcCodexPrompt(snapshot(read("question").replace("› 1.", "  1.").replace("  2.", "› 2.")), "question"));
  assert.equal(inspectHcCodexPrompt(snapshot(read("question")), "permission"), null);
  assert.equal(inspectHcCodexPrompt({ ...snapshot(read("question")), complete: false }, "question"), null);
  assert.equal(inspectHcCodexPrompt(snapshot(read("approval")), "permission")?.kind, "permission");
  const approval = read("approval");
  assert.equal(inspectHcCodexPrompt(snapshot(approval + "\n› Ask Codex to do anything"), "permission"), null);
  assert.equal(inspectHcCodexPrompt(snapshot(approval + "\n\nUnclassified dialog\n  Press enter to confirm or esc to cancel"), "permission"), null);
  assert.equal(inspectHcCodexPrompt(snapshot(read("model")))?.kind, "model");
  assert.equal(inspectHcCodexPrompt(snapshot(read("model-effort")))?.kind, "effort");
});
