import type { BlockedPrompt, PromptFingerprintInput } from "./driver.js";

/**
 * Identity of the prompt currently on a pane, or null if nothing recognizable
 * is showing.
 *
 * Exists because herdr reports one `blocked` for every prompt: answering one at
 * the terminal and landing on the next never passes through a non-blocked
 * status, so "is this still the prompt we posted?" cannot be answered from
 * status alone. Comparing this across polls is what catches the substitution.
 *
 * Everything the user can change *without* resolving the prompt is deliberately
 * excluded, since a false difference would re-post a prompt that is still
 * pending — the very repetition this was untangled from. That means the cursor
 * marker (moved by arrow keys) and multi-select checkbox state (toggled with
 * space) are normalized away; the option text and the command being asked about
 * are what remain. Returns null rather than a fingerprint of nothing when the
 * pane doesn't parse, so an empty or garbled read is never mistaken for a
 * change.
 */
/** Drops every space, so a value rebuilt from wrapped lines compares equal
 *  however the terminal happened to break it. */
function squash(value: string): string {
  return value.replace(/\s+/g, "");
}

export function promptFingerprint(prompt: PromptFingerprintInput | BlockedPrompt): string | null {
  if (prompt.kind === "question") {
    const info = prompt.info;
    // Descriptions and the multi-select flag are part of the question's identity:
    // without them, two consecutive prompts sharing a question and its labels but
    // differing in their explanations read as the same prompt. The checkbox
    // *state* stays excluded — that is the part a person toggles with space — but
    // whether the question is multi-select at all cannot change under them.
    return [
      "q",
      info.header,
      info.question,
      info.multiSelect ? "multi" : "single",
      // Whitespace stripped, not just collapsed: a description is rebuilt from
      // however many lines the column wrapped it into, joined with spaces, so
      // resizing the terminal changes where those spaces fall. Comparing with
      // them in would have re-posted a prompt that was still pending — the
      // false-positive direction this fingerprint exists to avoid.
      ...info.options.map((o) => `${squash(o.label)}\u0000${squash(o.description ?? "")}`),
    ].join("\u0001");
  }
  if (prompt.kind !== "permission" || !prompt.menu) return null;
  const choices = prompt.menu.choices.map((c) => `${c.num}.${c.label}`).join(" ");
  // The cursor glyph sits at the start of whichever option is selected, and the
  // indentation shifts with it, so both are normalized away — but only there.
  // Stripping those characters everywhere collapsed real differences in the text
  // being asked about: `echo x > out` and `echo x out` produced one fingerprint.
  const context = prompt.menu.snippet
    .split("\n")
    .map((line) => line.replace(/^\s*[›❯>]\s?/, "").trim())
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return ["p", choices, context].join("\u0001");
}
