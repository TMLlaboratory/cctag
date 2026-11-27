import { setTimeout as delay } from "node:timers/promises";
import type { ClaudeComposer } from "../agents/claude/composer.js";
import { classifyComposerProbe, composerProbeKey } from "./composer-probe.js";
import type { SubmitContext, SubmitOutcome } from "./index.js";
import { EMPTY_SUBMIT_COMPOSER_STATE, hasUnsendableC0Controls, SubmitRefused, type SubmitComposerState } from "./types.js";

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
    view.draft === expected.draft && view.caret === expected.caret &&
    view.frame === expected.frame && view.nativeCaret === expected.nativeCaret && view.stashed === expected.stashed;
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
  const proveEnd = async (base: ClaudeComposer, reason: SubmitRefused["reason"]) => {
    // Right exposes an unpainted trailing space when the following letter makes it visible.
    await key(["right", "x"], base, reason, { probe: "x" });
    const appended = base.draft + "x";
    const pastSpace = base.draft + " x";
    const proof = await waitFor((view) =>
      view.frame === base.frame && view.nativeCaret === base.nativeCaret && view.stashed === base.stashed &&
      (view.draft === appended || view.draft === pastSpace) &&
      view.caret === view.draft.length, "probe-unverified");
    const occupied = proof.draft === pastSpace;
    await key(occupied ? ["backspace", "left"] : ["backspace"], proof, "probe-unverified");
    await waitFor((view) => matches(view, base), "probe-unverified");
    composer = { ...composer, probe: null };
    return !occupied;
  };
  if (hasUnsendableC0Controls(text)) throw refuse("unsafe-text");
  notCancelled();
  const initial = await read();
  if (initial.stashed) throw refuse("existing-stash");
  if (initial.nativeProbeFits === false) throw refuse("draft");

  let ready = initial;
  if (initial.draft) {
    const { suggestion, reversed } = await probe(initial, "probe-unverified");
    ready = reversed;
    if (!suggestion) {
      // A menu or image conversion can interrupt submission before the draft comes back.
      if (text.trimStart().startsWith("/") || ctx.hasImages) throw refuse("draft");
      if (ready.nativeCaret) {
        const distance = ready.draft.length - ready.caret;
        const end = { ...ready, caret: ready.draft.length };
        if (distance > 0) {
          await key(Array<string>(distance).fill("right"), ready, "probe-unverified");
          await waitFor((view) => matches(view, end), "probe-unverified");
        }
        const complete = await proveEnd(end, "probe-unverified");
        if (distance > 0) {
          await key(Array<string>(distance).fill("left"), end, "probe-unverified");
          await waitFor((view) => matches(view, ready), "probe-unverified");
        }
        if (!complete) throw refuse("draft");
      }
      await key(["ctrl+s"], ready, "stash-unverified", { stash: "uncertain" });
      ready = await waitFor((view) => view.stashed, "stash-unverified");
      composer = { ...composer, stash: "stashed" };
      if (ready.draft) throw refuse("stash-unverified");
    }
  }

  const changed = composer.stash === "stashed" ? "stash-unverified" : "draft";
  if (!ready.draft && !(await proveEnd(ready, changed))) throw refuse(changed);
  await recheck(ready, changed, ready.draft !== "");
  notCancelled();
  return ops.send(composer);
}
