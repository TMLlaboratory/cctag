import { test } from "node:test";
import assert from "node:assert/strict";
import { promptFingerprint, type BlockedPrompt } from "./driver.js";

function permission(snippet: string, choices = ["Yes", "No"]): BlockedPrompt {
  return {
    kind: "permission",
    menu: { choices: choices.map((label, i) => ({ num: String(i + 1), label })), snippet },
    isPlanPrompt: false,
  };
}

function question(
  opts: { question?: string; header?: string; multiSelect?: boolean; options: { label: string; description?: string }[] },
): BlockedPrompt {
  return {
    kind: "question",
    info: {
      header: opts.header ?? "見出し",
      question: opts.question ?? "どうしますか？",
      options: opts.options,
      multiSelect: opts.multiSelect ?? false,
    },
  };
}

test("two commands differing only by a redirection are told apart", () => {
  // The cursor glyph used to be stripped wherever it appeared, and `>` is one of
  // the glyphs — so a redirection in the command being approved vanished with it
  // and these two prompts shared a fingerprint. Answering one at the terminal and
  // landing on the other would then have gone unnoticed.
  const a = promptFingerprint(permission(["Bash command", "", "  echo x > out", "", "Do you want to proceed?"].join("\n")));
  const b = promptFingerprint(permission(["Bash command", "", "  echo x out", "", "Do you want to proceed?"].join("\n")));
  assert.notEqual(a, b);
});

test("moving the cursor between options is still the same prompt", () => {
  // The false-positive side, and the more dangerous one: a fingerprint that
  // changed on arrow keys would re-post a prompt that is still pending.
  const onFirst = promptFingerprint(permission(["Do you want to proceed?", "❯ 1. Yes", "  2. No"].join("\n")));
  const onSecond = promptFingerprint(permission(["Do you want to proceed?", "  1. Yes", "❯ 2. No"].join("\n")));
  assert.equal(onFirst, onSecond);
});

test("a cursor drawn as > is still normalized away", () => {
  const withGlyph = promptFingerprint(permission(["Do you want to proceed?", "❯ 1. Yes", "  2. No"].join("\n")));
  const withGt = promptFingerprint(permission(["Do you want to proceed?", "> 1. Yes", "  2. No"].join("\n")));
  assert.equal(withGlyph, withGt, "which is why the glyph cannot simply be left in place");
});

test("questions differing only in their descriptions are told apart", () => {
  const a = promptFingerprint(question({ options: [{ label: "A", description: "速いが荒い" }, { label: "B" }] }));
  const b = promptFingerprint(question({ options: [{ label: "A", description: "遅いが正確" }, { label: "B" }] }));
  assert.notEqual(a, b, "the explanation is part of what the question asks");
});

test("a multi-select question is not the same prompt as a single-select one", () => {
  const single = promptFingerprint(question({ options: [{ label: "A" }, { label: "B" }] }));
  const multi = promptFingerprint(question({ multiSelect: true, options: [{ label: "A" }, { label: "B" }] }));
  assert.notEqual(single, multi);
});

test("labels cannot be run together to forge a match", () => {
  // Joined on a separator that cannot occur in a label, so ["AB"] and ["A","B"]
  // stay distinct.
  const one = promptFingerprint(question({ options: [{ label: "AB" }, { label: "C" }] }));
  const two = promptFingerprint(question({ options: [{ label: "A" }, { label: "BC" }] }));
  assert.notEqual(one, two);
});

test("an unparseable pane has no identity rather than a fake one", () => {
  assert.equal(promptFingerprint({ kind: "permission", menu: null, isPlanPrompt: false }), null);
});
