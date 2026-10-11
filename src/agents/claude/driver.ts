import { basename, join } from "node:path";

import { promptFingerprint } from "../fingerprint.js";
import type { AgentDriver, AskUserQuestionPaneInfo, BlockedPrompt, ModelCommandResult } from "../driver.js";
import type { AnswerChannel, Terminals } from "../../backend/index.js";
import { createBlindPermissionPrompt, createVerifiedPrompt } from "../../backend/prompt.js";
import {
  ExpectationLost,
  hasUnsendableC0Controls,
  UNSENDABLE_TEXT_MESSAGE,
} from "../../backend/types.js";
import type { AgentInfo, AgentRef, ScreenSnapshot } from "../../backend/types.js";
import {
  findPlanFeedbackOption,
  MODE_ALIASES,
  MODE_RING,
  looksLikeQuestionScreen,
  parseAskUserQuestionPane,
  parseClaudeStartupPrompt,
  parseCurrentMode,
  parsePermissionMenu,
  parsePreviewQuestionPane,
  SUBMIT_ANSWERS_RE,
  classicAnchorIndex,
  permissionAnchorIndex,
  previewAnchorIndex,
  parseCursorLabel as parseClaudeCursorLabel,
  stripFooterChrome,
} from "./prompts.js";
import {
  extractAssistantText,
  extractLifecycle,
  extractSendUserFileRequests,
  extractToolOutcomes,
  extractToolUseSummaries,
  locateClaudeTranscript,
  type TranscriptRecord,
} from "./transcript.js";
import { resolvePlanFile } from "./plan.js";

import { backendForTarget } from "../../backend/target.js";
/** Same question, by everything visible about it — see answerQuestionOption. */
function sameQuestion(
  a: { question: string; options: { label: string }[] },
  b: { question: string; options: { label: string }[] },
): boolean {
  return (
    a.question === b.question &&
    a.options.length === b.options.length &&
    a.options.every((o, i) => o.label === b.options[i].label)
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function assertAnswerNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new ExpectationLost("the compound answer was interrupted before completion");
  }
}
const ANSWER_REVIEW_FAILURE =
  "確認画面を確かめられなかったので送信していません。端末で確かめてください";

function normalizedReviewText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function answerListsMatch(
  visible: readonly string[],
  expected: readonly string[],
): boolean {
  const normalizedVisible = visible.map(normalizedReviewText);
  const normalizedExpected = expected.map(normalizedReviewText);
  if (normalizedExpected.some((answer) => answer.includes(","))) {
    return normalizedVisible.join(", ") === normalizedExpected.join(", ");
  }

  const visibleLabels = normalizedVisible.flatMap((answer) =>
    answer.split(/,\s*/u).map(normalizedReviewText),
  );
  const sortedVisible = visibleLabels.sort();
  const sortedExpected = normalizedExpected.sort();
  return (
    sortedVisible.length === sortedExpected.length &&
    sortedVisible.every((answer, index) => answer === sortedExpected[index])
  );
}

// A session given a name with `/rename` draws that name into the rule above the
// prompt (`──── design ─`), and only that rule; the one below stays plain.
// Captured live on Claude Code 2.1.291. Requiring a bare rule above refused
// every Slack message to a named session as "not idle" (#28).
const COMPOSER_TOP_RULE_RE = /^[─━]+(?: .+ [─━]+)?$/u;
const COMPOSER_BOTTOM_RULE_RE = /^[─━]+$/u;

function composerFooterStart(rows: readonly string[], acceptTryPlaceholder = false): number | null {
  for (let i = 1; i < rows.length - 1; i++) {
    const inputRow = rows[i]!.trim();
    const isTryPlaceholder = acceptTryPlaceholder && /^❯\s+Try ".+"$/u.test(inputRow);
    if (inputRow !== "❯" && !isTryPlaceholder) continue;
    if (!COMPOSER_TOP_RULE_RE.test(rows[i - 1]!.trim()) || !COMPOSER_BOTTOM_RULE_RE.test(rows[i + 1]!.trim())) continue;
    if (rows.slice(i + 2).some((row) => row.trim())) return i - 1;
  }
  return null;
}

const NAMED_COMPOSER_TOP_RULE_RE = /^[─━]+ .+ [─━]+$/u;

// Recovered only under a named rule: that is the one layout Orca's extractor is
// known to miss (it lifts the text into `draft` only below a bare rule, Orca
// 1.4.218). Anywhere else a missing draft means Orca could not place the
// composer at all, and reading one out of the rows would be a guess about where
// the next keystroke lands (#30).
function recoverComposerDraft(snap: ScreenSnapshot): ScreenSnapshot {
  if (snap.draft !== null) return snap;
  const rows = snap.text.split(/\r?\n/);
  for (let i = rows.length - 2; i >= 1; i--) {
    const text = /^❯\s(.+)$/u.exec(rows[i]!.trim())?.[1];
    if (text === undefined || /^Try ".+"$/u.test(text)) continue;
    if (!NAMED_COMPOSER_TOP_RULE_RE.test(rows[i - 1]!.trim()) || !COMPOSER_BOTTOM_RULE_RE.test(rows[i + 1]!.trim())) {
      continue;
    }
    rows[i] = "❯";
    return { ...snap, text: rows.join("\n"), draft: text };
  }
  return snap;
}

function isComposerFooterSuffix(rows: readonly string[]): boolean {
  const start = composerFooterStart(rows);
  return start !== null && rows.slice(0, start).every((row) => !row.trim());
}

function hasPromptInReviewSuffix(text: string): boolean {
  return (
    parseAskUserQuestionPane(text) !== null ||
    parsePreviewQuestionPane(text) !== null ||
    parsePermissionMenu(text) !== null ||
    parseClaudeStartupPrompt(text) !== null ||
    looksLikeQuestionScreen(text)
  );
}

function answerReviewFingerprint(
  snap: ScreenSnapshot,
  expected?: { question: string; answers: readonly string[]; deadlineAt?: number },
): string | null {
  if (!snap.complete) return null;
  const rows = snap.text.split(/\r?\n/);
  const headingAt = rows.lastIndexOf("Ready to submit your answers?");
  const reviewAt = rows.lastIndexOf("Review your answers", headingAt);
  if (reviewAt < 0 || headingAt < 0) return null;
  const submitRow = rows[headingAt + 1];
  const cancelRow = rows[headingAt + 2];
  if (
    !submitRow ||
    !/^\s*❯\s*1\.\s*Submit answers\s*$/.test(submitRow) ||
    !cancelRow ||
    !/^\s*2\.\s*Cancel\s*$/.test(cancelRow) ||
    parseClaudeCursorLabel(snap.text) !== "Submit answers"
  ) {
    return null;
  }

  const suffixRows = rows.slice(headingAt + 3);
  const suffix = suffixRows.join("\n");
  if (
    suffixRows.some((row) => row.trim()) &&
    (!isComposerFooterSuffix(suffixRows) || hasPromptInReviewSuffix(suffix))
  ) {
    return null;
  }

  const contentRows = rows.slice(reviewAt + 1, headingAt);
  const answersByQuestion = new Map<string, string[]>();
  let question: string | null = null;
  for (const row of contentRows) {
    if (!row.trim()) continue;
    const questionRow = /^\s*●\s*(.*?)\s*$/.exec(row);
    if (questionRow) {
      question = normalizedReviewText(questionRow[1]!);
      if (!question) return null;
      answersByQuestion.set(question, []);
      continue;
    }
    const answerRow = /^\s*→\s*(.*?)\s*$/.exec(row);
    if (answerRow && question !== null) {
      const visibleAnswer = normalizedReviewText(answerRow[1]!);
      if (!visibleAnswer) return null;
      answersByQuestion.get(question)!.push(visibleAnswer);
      continue;
    }
    return null;
  }

  if (expected) {
    const visibleAnswers = answersByQuestion.get(normalizedReviewText(expected.question));
    if (!visibleAnswers || !answerListsMatch(visibleAnswers, expected.answers)) return null;
  }

  return promptFingerprint({
    kind: "question",
    info: {
      header: "Review your answers",
      question: "Ready to submit your answers?",
      multiSelect: false,
      options: [
        { label: "Submit answers", description: contentRows.join("\n") },
        { label: "Cancel" },
      ],
    },
  });
}

async function confirmOrcaAnswerReview(
  terminals: Terminals,
  channel: AnswerChannel,
  ref: AgentRef,
  info: AskUserQuestionPaneInfo,
  answers: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (true) {
    assertAnswerNotAborted(signal);
    if (Date.now() >= deadline) {
      throw new ExpectationLost(ANSWER_REVIEW_FAILURE, ANSWER_REVIEW_FAILURE);
    }
    let snap: ScreenSnapshot;
    try {
      snap = await terminals.read(ref.target, 60, "screen");
    } catch {
      assertAnswerNotAborted(signal);
      throw new ExpectationLost(ANSWER_REVIEW_FAILURE, ANSWER_REVIEW_FAILURE);
    }
    assertAnswerNotAborted(signal);
    if (Date.now() >= deadline) {
      throw new ExpectationLost(ANSWER_REVIEW_FAILURE, ANSWER_REVIEW_FAILURE);
    }
    const review = claudeDriver.parseAnswerReview?.(snap, {
      question: info.question,
      answers,
      deadlineAt: deadline,
    });
    if (review) {
      assertAnswerNotAborted(signal);
      if (Date.now() >= deadline) {
        throw new ExpectationLost(ANSWER_REVIEW_FAILURE, ANSWER_REVIEW_FAILURE);
      }
      const reviewChannel = terminals.openAnswer(ref, review);
      assertAnswerNotAborted(signal);
      if (Date.now() >= deadline) {
        throw new ExpectationLost(ANSWER_REVIEW_FAILURE, ANSWER_REVIEW_FAILURE);
      }
      await reviewChannel.digit(1, true);
      channel.complete();
      return;
    }
    if (Date.now() >= deadline) {
      throw new ExpectationLost(ANSWER_REVIEW_FAILURE, ANSWER_REVIEW_FAILURE);
    }
    await sleep(100);
  }
}

/**
 * Runs a CLI slash command (`/model <name>`, ...) rather than a normal
 * conversational turn. These don't reliably show up in the session
 * transcript the way an LLM reply does, so this reads the result straight
 * off the pane. If a confirmation menu appears (e.g. switching models
 * mid-conversation asks "Switch model? Yes/No"), it's auto-confirmed with
 * the first option, since the user asking for the command already expressed
 * that intent.
 */
async function runClaudeSlashCommand(
  terminals: Terminals,
  driver: AgentDriver,
  agent: AgentInfo,
  command: string,
): Promise<ModelCommandResult> {
  // Atomic submit — same reason as TurnEngine.startTurn: a separate
  // send-text + Enter races Claude Code's paste coalescing and can leave the
  // command unsent. Terminals.submit keeps it one server-side operation.
  const submitOutcome = await terminals.submit(agent.ref, command, {
    driver,
    cancelled: () => false,
    transcriptGrew: () => false,
    retryLimit: 0,
    pollIntervalMs: 0,
  });

  let settled = false;
  for (let i = 0; i < 10 && !settled; i++) {
    await sleep(600);
    const cur = await terminals.get(agent.ref.target);
    if (!cur) break;

    // Some confirmation menus — notably "Switch model? ... this
    // conversation is cached, switching means the full history gets
    // re-read" — Herdr keeps classifying this menu as `idle` rather than
    // `blocked` (verified empirically). So inspect the pane for a parseable menu
    // on every iteration, not only when status says `blocked` — otherwise this
    // dialog is mistaken for "already settled" and left unanswered.
    const paneText = (await terminals.read(agent.ref.target, 40, "history")).text;
    const menu = parsePermissionMenu(paneText);
    if (menu && menu.choices.length > 0) {
      const parsed = driver.parseBlockedPane(paneText);
      if (parsed.kind === "question" || parsed.kind === "permission") {
        await terminals.openAnswer(agent.ref, parsed.verified).digit(Number(menu.choices[0].num));
      }
      continue;
    }

    const status = cur.evidence.kind === "classified" ? cur.evidence.status : "unknown";
    if (status === "idle" || status === "done") {
      settled = true;
    }
  }

  const raw = (await terminals.read(agent.ref.target, 40, "history")).text;
  const snippet = stripFooterChrome(raw);
  return { reply: "```\n" + snippet.slice(-1500) + "\n```", submitOutcome };
}

export const claudeDriver: AgentDriver = {
  kind: "claude",
  orcaProcess: {
    listable: true,
    hooks: {
      agent: "claude",
      missingNotice: "Orca Claude hooks are not installed; state hints may be incomplete.",
      unavailableNotice: "Unable to confirm Orca Claude hook installation; state hints may be incomplete.",
    },
    matchesCommand(command) {
      const [executable, ...args] = command.trim().split(/\s+/);
      const name = basename(executable ?? "");
      return name === "claude" || (name === "node" && args.some((arg) => arg.includes("@anthropic-ai/claude-code")));
    },
    async session(process, access) {
      const path = join(access.homeDir, ".claude", "sessions", `${process.pid}.json`);
      const session = JSON.parse(await access.readFile(path)) as { sessionId?: unknown };
      if (typeof session.sessionId !== "string" || session.sessionId.length === 0) {
        throw new Error("Claude session id is missing");
      }
      return { sessionId: session.sessionId };
    },
  },

  displayName: "Claude Code",
  readRegion: "history",

  locateTranscript(cwd, sessionId) {
    return locateClaudeTranscript(cwd, sessionId);
  },

  extractTurnOutput(records) {
    const r = records as TranscriptRecord[];
    return {
      texts: extractAssistantText(r),
      toolNames: extractToolUseSummaries(r),
      lifecycle: extractLifecycle(r),
      sendFileRequests: extractSendUserFileRequests(r),
      toolOutcomes: extractToolOutcomes(r),
    };
  },
  extractLifecycle(records) {
    return extractLifecycle(records as TranscriptRecord[]);
  },

  parseStartupPrompt: parseClaudeStartupPrompt,
  looksLikeQuestionScreen,

  parseBlockedPane(paneText): BlockedPrompt {
    // Whichever dialog sits lowest on the screen is the live one — a read wide
    // enough for a tall prompt also holds already-answered ones above it. Trying
    // the parsers in a fixed order instead let a stale classic dialog above a
    // live preview question win, and a stale preview question above a live
    // permission menu do the same: the wrong prompt was posted, or the right one
    // never was.
    const candidates: {
      at: number;
      form: "digit-confirms" | "digit-then-enter";
      parse: () => AskUserQuestionPaneInfo | null;
    }[] = [
      { at: classicAnchorIndex(paneText), form: "digit-confirms", parse: () => parseAskUserQuestionPane(paneText) },
      { at: previewAnchorIndex(paneText), form: "digit-then-enter", parse: () => parsePreviewQuestionPane(paneText) },
    ];
    const permissionAt = permissionAnchorIndex(paneText);
    for (const candidate of candidates.filter((c) => c.at >= 0).sort((a, b) => b.at - a.at)) {
      // A permission menu below a question dialog means the question is gone —
      // its own options are numbered too, so it must not be parsed as one.
      if (permissionAt > candidate.at) break;
      const info = candidate.parse();
      if (info) {
        const content = { kind: "question" as const, info };
        const fingerprint = promptFingerprint(content);
        if (fingerprint === null) return { kind: "unreadable-question" };
        return {
          ...content,
          verified: createVerifiedPrompt(
            fingerprint,
            claudeDriver,
            info.multiSelect ? "compound" : candidate.form,
          ),
        };
      }
    }
    const menu = parsePermissionMenu(paneText);
    if (!menu) {
      return looksLikeQuestionScreen(paneText)
        ? { kind: "unreadable-question" }
        : { kind: "blind-permission", blind: createBlindPermissionPrompt(claudeDriver, "key-confirms") };
    }
    const feedbackNum = findPlanFeedbackOption(paneText);
    const content = {
      kind: "permission" as const,
      menu,
      isPlanPrompt: feedbackNum !== null,
      planFeedbackOptionNum: feedbackNum ?? undefined,
    };
    const fingerprint = promptFingerprint(content);
    if (fingerprint === null) {
      return { kind: "blind-permission", blind: createBlindPermissionPrompt(claudeDriver, "key-confirms") };
    }
    return {
      ...content,
      verified: createVerifiedPrompt(
        fingerprint,
        claudeDriver,
        feedbackNum === null ? "digit-confirms" : "compound",
      ),
    };
  },
  parseAnswerReview(snap, expected) {
    const fingerprint = answerReviewFingerprint(snap, expected);
    return fingerprint === null
      ? null
      : createVerifiedPrompt(fingerprint, claudeDriver, "digit-confirms", {
          expectedCursorLabel: "Submit answers",
          ...(expected?.deadlineAt === undefined
            ? {}
            : { expiresAt: expected.deadlineAt, expiredUserMessage: ANSWER_REVIEW_FAILURE }),
        });
  },
  parseCursorLabel(snap) {
    return snap.complete ? parseClaudeCursorLabel(snap.text) : null;
  },
  composerProbe: true,
  isIdleComposer(snap) {
    if (!snap.complete) return false;
    const rows = snap.text.split(/\r?\n/);
    if (rows.some((row) => /^✳\s+\S/u.test(row.trimStart()))) return false;

    return composerFooterStart(rows, snap.draft === null) !== null;
  },
  recoverComposerDraft,

  async answerOption(channel, value, _expectedLabel) {
    await channel.digit(Number(value));
  },

  async answerQuestionOption(terminals, channel, target, optionNum, answered, signal) {
    await channel.digit(optionNum);
    await sleep(400);
    // Deliberately not caught. Without a successful read there is no way to know
    // whether the digit confirmed, and reporting success would let the caller
    // mark the Slack prompt answered while the pane still waits — the prompt
    // would then be re-posted on the next poll. Throwing leaves it answerable.
    const after = (await terminals.read(target, 200, "history")).text;

    // Whether that digit already confirmed depends on which renderer drew the
    // question, and the two are chosen per question, so the pane is the only
    // reliable witness. Still showing the same question means the digit merely
    // moved the cursor (the preview renderer) and Enter is still owed. Anything
    // else — the next question, the submit menu, a working pane — means it
    // confirmed and moved on, where an Enter would answer something else.
    //
    // Compared on the options too, not the question text alone: a following
    // question that happens to repeat the wording would otherwise look like the
    // same prompt and take an Enter meant for its predecessor.
    const still = parsePreviewQuestionPane(after);
    if (!still || !sameQuestion(still, answered)) return;

    // The pane may have been handed to something else while we waited: the
    // holder releases as soon as it is asked to stop, and this runs outside that
    // loop. A read is harmless, a keystroke is not.
    if (signal?.aborted) return;
    const expectedLabel = answered.options[optionNum - 1]?.label;
    if (expectedLabel !== undefined) await channel.confirm(expectedLabel);
  },

  async answerQuestionMultiSelect(terminals, channel, ref, optionNums, info, signal) {
    // Every step below was measured on a live multi-select dialog (Claude Code
    // 2.1.251), not inferred from the single-select path — the last multi-select
    //
    //     ❯ 1. [ ] Alpha        <- a digit toggles this to [✔] and does NOT
    //       2. [ ] Bravo           move the cursor or submit
    //       3. [ ] Charlie
    //       4. [ ] Delta
    //       5. [ ] Type something
    //          Submit           <- Down × (options.length + 1) lands here
    assertAnswerNotAborted(signal);
    for (const num of optionNums) {
      assertAnswerNotAborted(signal);
      await channel.digit(num);
      await sleep(150);
    }

    // The free-text row is options.length + 1, and Submit sits one past it. The
    // cursor has not moved (the digits do not move it), so this count is from
    // row 1 every time. answerQuestionFreeText uses options.length downs to
    // reach the free-text row, which is the same geometry one row up.
    assertAnswerNotAborted(signal);
    await channel.move("Down", info.options.length + 1);
    await sleep(200);
    assertAnswerNotAborted(signal);
    await channel.confirm("Submit", false);

    // Enter on Submit does not finish the dialog: a review screen appears —
    //
    //     Ready to submit your answers?
    //     ❯ 1. Submit answers
    //       2. Cancel
    //
    // — but only when this was the *last* question of the dialog. For an earlier
    // one the next question comes up instead, and a `1` sent there would toggle
    // that question's first option. The pane is the witness before sending `1`.
    // Orca requires the complete review; Herdr keeps its existing non-review
    // transition behavior and leaves that next question for the poll loop.
    await sleep(500);
    assertAnswerNotAborted(signal);
    if (backendForTarget(ref.target) === "orca") {
      const selected = new Set(optionNums);
      const answers = info.options.flatMap((option, index) => (selected.has(index + 1) ? [option.label] : []));
      await confirmOrcaAnswerReview(terminals, channel, ref, info, answers, signal);
      return;
    }
    const after = (await terminals.read(ref.target, 60, "history")).text;
    assertAnswerNotAborted(signal);
    if (!SUBMIT_ANSWERS_RE.test(after)) {
      channel.complete();
      return;
    }
    await channel.digit(1, true);
  },

  async answerQuestionFreeText(terminals, channel, ref, info, text, signal) {
    // Navigate down to the "Type something" row (the free-text row must be
    // reached via arrows and then have its placeholder replaced before Enter).
    const isOrca = backendForTarget(ref.target) === "orca";
    if (isOrca && hasUnsendableC0Controls(text)) {
      throw new ExpectationLost(UNSENDABLE_TEXT_MESSAGE, UNSENDABLE_TEXT_MESSAGE);
    }
    if (isOrca) assertAnswerNotAborted(signal);
    if (info.options.length > 0) await channel.move("Down", info.options.length);
    if (isOrca) assertAnswerNotAborted(signal);
    await channel.text(text);
    await sleep(200);

    if (!info.multiSelect) {
      if (isOrca) assertAnswerNotAborted(signal);
      await channel.confirm(text);
      return;
    }

    // On a multi-select dialog that same Enter *undoes* the answer. Measured on
    // a live 2.1.251 pane, replying "1,3" to a three-option question:
    //
    //     ❯ 4. [✔] 1,3      typing into the row ticks it automatically
    //     ❯ 4. [ ] 1,3      ... and Enter, which here means "select", unticks it
    //
    // The dialog then just sits there with the text typed, deselected and
    // unsubmitted — reported from production as "replying 1,3 didn't work".
    // Submitting is the same walk as answerQuestionMultiSelect's: one more Down
    // onto Submit, Enter, then confirm the review screen.
    if (isOrca) assertAnswerNotAborted(signal);
    await channel.move("Down", 1);
    await sleep(150);
    if (isOrca) assertAnswerNotAborted(signal);
    await channel.confirm("Submit", false);
    if (isOrca) {
      await confirmOrcaAnswerReview(terminals, channel, ref, info, [text], signal);
      return;
    }
    await sleep(500);
    const after = (await terminals.read(ref.target, 60, "history")).text;
    if (!SUBMIT_ANSWERS_RE.test(after)) {
      channel.complete();
      return;
    }
    await channel.digit(1, true);
  },

  async answerPlanFeedback(channel, optionNum, text) {
    // Verified mechanics: send the option's digit to move the cursor there,
    // type the feedback — which replaces the option's placeholder label
    // inline — then Enter, which refines the plan and stays in plan mode.
    await channel.digit(optionNum);
    await sleep(200);
    await channel.text(text);
    await sleep(200);
    await channel.confirm(text);
  },

  resolvePlanFile,

  modes: {
    ring: MODE_RING,
    aliases: MODE_ALIASES,
    parseCurrent: parseCurrentMode,
    async cycle(channel) {
      // herdr's `send-keys shift+tab` is a no-op for Claude Code; the raw
      // CSI Z sequence sent as text does work (verified empirically).
      await channel.backTab();
    },
  },

  async runModelCommand(terminals, agent, argsText) {
    return runClaudeSlashCommand(terminals, claudeDriver, agent, `/model ${argsText}`);
  },
};
