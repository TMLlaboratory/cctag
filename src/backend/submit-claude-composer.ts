import { setTimeout as delay } from "node:timers/promises";
import type { ClaudeComposer } from "../agents/claude/composer.js";
import { classifyComposerProbe, composerProbeKey } from "./composer-probe.js";
import type { SubmitContext, SubmitOutcome } from "./index.js";
import { EMPTY_SUBMIT_COMPOSER_STATE, hasUnsendableC0Controls, SubmitRefused, WriteOutcomeUnknown, type SubmitComposerState } from "./types.js";

export async function submitClaudeComposer(text: string, ctx: SubmitContext, ops: {
  read(): Promise<ClaudeComposer | null>;
  key(...names: string[]): Promise<void>;
  send(composer: SubmitComposerState): Promise<SubmitOutcome>;
}): Promise<SubmitOutcome> {
  let composer = EMPTY_SUBMIT_COMPOSER_STATE;
  const refuse = (reason: SubmitRefused["reason"]) => new SubmitRefused(reason, reason, composer);
  const notCancelled = () => {
    if (ctx.cancelled()) throw refuse("cancelled");
  };
  const read = async () => {
    const view = await ops.read().catch((error: unknown) => {
      if (error instanceof SubmitRefused) throw refuse(error.reason);
      throw refuse("incomplete-screen");
    });
    notCancelled();
    if (!view) throw refuse("incomplete-screen");
    if (!view.idle) throw refuse("not-idle");
    return view;
  };
  const matches = (view: ClaudeComposer, expected: ClaudeComposer) =>
    view.draft === expected.draft && view.caret === expected.caret && view.frame === expected.frame;
  const recheck = async (expected: ClaudeComposer, reason: SubmitRefused["reason"], compareRawRow = false) => {
    notCancelled();
    const latest = await read();
    notCancelled();
    if (!matches(latest, expected) || (compareRawRow && latest.rawRow !== expected.rawRow)) {
      throw refuse(reason);
    }
  };
  const waitFor = async (accept: (view: ClaudeComposer) => boolean, reason: SubmitRefused["reason"]) => {
    const deadline = Date.now() + 500;
    do {
      notCancelled();
      const view = await read();
      if (accept(view)) return view;
      if (Date.now() < deadline) await delay(35);
    } while (Date.now() < deadline);
    throw refuse(reason);
  };
  const key = async (
    names: string[], expected: ClaudeComposer, reason: SubmitRefused["reason"],
    next: Partial<SubmitComposerState> = {},
  ) => {
    await recheck(expected, reason);
    notCancelled();
    composer = { ...composer, ...next };
    try {
      await ops.key(...names);
    } catch {
      throw refuse(reason);
    }
  };
  const probe = async (base: ClaudeComposer, reason: "probe-unverified" | "stash-unverified") => {
    const letter = composerProbeKey(base.draft);
    const classify = (draft: string) => classifyComposerProbe(base.draft, base.caret, letter, draft);
    await key([letter], base, reason, { probe: letter });
    const probed = await waitFor((view) => view.stashed === base.stashed && (
      classify(view.draft) === "suggestion" ? view.caret === 1
        : classify(view.draft) === "typed" && view.caret === base.caret + 1
    ), reason);
    const suggestion = classify(probed.draft) === "suggestion";
    await key(["backspace"], probed, reason);
    const reversed = await waitFor((view) => view.stashed === base.stashed && (
      (view.draft === base.draft && view.caret === base.caret && (!suggestion || view.rawRow === base.rawRow))
      || (suggestion && view.draft === "")
    ), reason);
    composer = { ...composer, probe: null };
    return { suggestion, reversed };
  };
  if (hasUnsendableC0Controls(text)) throw refuse("unsafe-text");
  notCancelled();
  const initial = await read();
  if (initial.stashed) throw refuse("existing-stash");

  let ready = initial;
  if (initial.draft) {
    // A slash command can open a menu and image conversion can consume Enter.
    if (text.trimStart().startsWith("/") || ctx.hasImages) throw refuse("draft");
    const { suggestion, reversed } = await probe(initial, "probe-unverified");
    ready = reversed;
    if (!suggestion) {
      await key(["ctrl+s"], ready, "stash-unverified", { stash: "uncertain" });
      ready = await waitFor((view) => view.stashed, "stash-unverified");
      composer = { ...composer, stash: "stashed" };
      if (ready.draft) throw refuse("stash-unverified");
    }
  }

  const changed = composer.stash === "stashed" ? "stash-unverified" : "draft";
  if (!ready.draft) {
    // Right can expose a hidden space even when the next painted cell still matches the empty row.
    await key(["right", "x"], ready, changed, { probe: "x" });
    const proof = await waitFor((view) =>
      view.frame === ready.frame && (view.draft === "x" || view.draft === " x") &&
      view.caret === view.draft.length, "probe-unverified");
    const occupied = proof.draft === " x";
    await key(occupied ? ["backspace", "left"] : ["backspace"], proof, "probe-unverified");
    await waitFor((view) => matches(view, ready), "probe-unverified");
    composer = { ...composer, probe: null };
    if (occupied) throw refuse(changed);
  }
  await recheck(ready, changed, ready.draft !== "");
  notCancelled();
  let outcome: SubmitOutcome;
  try {
    outcome = await ops.send(composer);
  } catch (err) {
    if (err instanceof WriteOutcomeUnknown && composer.stash === "stashed") {
      throw new WriteOutcomeUnknown(err, { ...err.composer, draftRestored: false });
    }
    throw err;
  }
  // Readback cannot distinguish the original text from the same text with a hidden trailing space.
  if (outcome.draftStashed) outcome.draftRestoration = "unverified";
  return outcome;
}
