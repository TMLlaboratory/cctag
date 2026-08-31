import type { AgentDriver, AskUserQuestionPaneInfo, BlockedPrompt } from "../driver.js";
import type { HerdrClient } from "../../herdr/client.js";
import {
  BACKTAB,
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
  herdr: HerdrClient,
  agent: { paneId: string },
  command: string,
): Promise<string> {
  // Atomic submit — same reason as TurnEngine.startTurn: a separate
  // send-text + Enter races Claude Code's paste coalescing and can leave the
  // command unsent. agent prompt sequences text + Enter server-side.
  await herdr.agentPrompt(agent.paneId, command);

  let settled = false;
  for (let i = 0; i < 10 && !settled; i++) {
    await sleep(600);
    const cur = await herdr.agentGet(agent.paneId);
    if (!cur) break;

    // Some confirmation menus — notably "Switch model? ... this
    // conversation is cached, switching means the full history gets
    // re-read" — don't flip agentStatus to "blocked" the way ordinary
    // permission/AskUserQuestion prompts do; herdr keeps reporting "idle"
    // while the menu sits on screen waiting for input (verified
    // empirically: status stayed "idle" for the entire time the dialog was
    // up). So check the pane for a parseable menu on every iteration, not
    // only when status says "blocked" — otherwise this dialog is mistaken
    // for "already settled" and left unanswered.
    const paneText = await herdr.paneRead(agent.paneId, { source: "recent", lines: 40 });
    const menu = parsePermissionMenu(paneText);
    if (menu && menu.choices.length > 0) {
      await herdr.agentSend(agent.paneId, menu.choices[0].num);
      continue;
    }

    if (cur.agentStatus === "idle" || cur.agentStatus === "done") {
      settled = true;
    }
  }

  const raw = await herdr.paneRead(agent.paneId, { source: "recent", lines: 40 });
  const snippet = stripFooterChrome(raw);
  return "```\n" + snippet.slice(-1500) + "\n```";
}

export const claudeDriver: AgentDriver = {
  kind: "claude",
  displayName: "Claude Code",
  paneReadSource: "recent",

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

  parseStartupPrompt: parseClaudeStartupPrompt,
  looksLikeQuestionScreen,

  parseBlockedPane(paneText): BlockedPrompt {
    // Whichever dialog sits lowest on the screen is the live one — a read wide
    // enough for a tall prompt also holds already-answered ones above it. Trying
    // the parsers in a fixed order instead let a stale classic dialog above a
    // live preview question win, and a stale preview question above a live
    // permission menu do the same: the wrong prompt was posted, or the right one
    // never was.
    const candidates: { at: number; parse: () => AskUserQuestionPaneInfo | null }[] = [
      { at: classicAnchorIndex(paneText), parse: () => parseAskUserQuestionPane(paneText) },
      { at: previewAnchorIndex(paneText), parse: () => parsePreviewQuestionPane(paneText) },
    ];
    const permissionAt = permissionAnchorIndex(paneText);
    for (const candidate of candidates.filter((c) => c.at >= 0).sort((a, b) => b.at - a.at)) {
      // A permission menu below a question dialog means the question is gone —
      // its own options are numbered too, so it must not be parsed as one.
      if (permissionAt > candidate.at) break;
      const info = candidate.parse();
      if (info) return { kind: "question", info };
    }
    const menu = parsePermissionMenu(paneText);
    const feedbackNum = findPlanFeedbackOption(paneText);
    return {
      kind: "permission",
      menu,
      isPlanPrompt: feedbackNum !== null,
      planFeedbackOptionNum: feedbackNum ?? undefined,
    };
  },

  async answerOption(herdr, paneId, value) {
    await herdr.agentSend(paneId, value);
  },

  async answerQuestionOption(herdr, paneId, optionNum, answered, signal) {
    await herdr.agentSend(paneId, String(optionNum));
    await sleep(400);
    // Deliberately not caught. Without a successful read there is no way to know
    // whether the digit confirmed, and reporting success would let the caller
    // mark the Slack prompt answered while the pane still waits — the prompt
    // would then be re-posted on the next poll. Throwing leaves it answerable.
    const after = await herdr.paneRead(paneId, { source: "recent", lines: 200 });

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
    await herdr.paneSendKeys(paneId, "Enter");
  },

  async answerQuestionMultiSelect(herdr, paneId, optionNums, info, signal) {
    // Every step below was measured on a live multi-select dialog (Claude Code
    // 2.1.251), not inferred from the single-select path — the last multi-select
    // bug came from a fixture written by assumption, so this one is a capture.
    //
    //     ❯ 1. [ ] Alpha        <- a digit toggles this to [✔] and does NOT
    //       2. [ ] Bravo           move the cursor or submit
    //       3. [ ] Charlie
    //       4. [ ] Delta
    //       5. [ ] Type something
    //          Submit           <- Down × (options.length + 1) lands here
    for (const num of optionNums) {
      await herdr.agentSend(paneId, String(num));
      await sleep(150);
    }

    // The free-text row is options.length + 1, and Submit sits one past it. The
    // cursor has not moved (the digits do not move it), so this count is from
    // row 1 every time. answerQuestionFreeText uses options.length downs to
    // reach the free-text row, which is the same geometry one row up.
    await herdr.paneSendKeys(paneId, ...Array(info.options.length + 1).fill("Down"));
    await sleep(200);
    if (signal?.aborted) return;
    await herdr.paneSendKeys(paneId, "Enter");

    // Enter on Submit does not finish the dialog: a review screen appears —
    //
    //     Ready to submit your answers?
    //     ❯ 1. Submit answers
    //       2. Cancel
    //
    // — but only when this was the *last* question of the dialog. For an earlier
    // one the next question comes up instead, and a `1` sent there would toggle
    // that question's first option. So the pane is the witness, exactly as in
    // answerQuestionOption; anything other than the review screen is left alone
    // for the poll loop to post.
    await sleep(500);
    if (signal?.aborted) return;
    const after = await herdr.paneRead(paneId, { source: "recent", lines: 60 });
    if (!SUBMIT_ANSWERS_RE.test(after)) return;
    if (signal?.aborted) return;
    await herdr.agentSend(paneId, "1");
  },

  async answerQuestionFreeText(herdr, paneId, info, text) {
    // Navigate down to the "Type something" row (the free-text row must be
    // reached via arrows and then have its placeholder replaced before Enter).
    const downs = Array(info.options.length).fill("Down");
    if (downs.length) await herdr.paneSendKeys(paneId, ...downs);
    await herdr.agentSend(paneId, text);
    await sleep(200);

    if (!info.multiSelect) {
      await herdr.paneSendKeys(paneId, "Enter");
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
    await herdr.paneSendKeys(paneId, "Down");
    await sleep(150);
    await herdr.paneSendKeys(paneId, "Enter");
    await sleep(500);
    const after = await herdr.paneRead(paneId, { source: "recent", lines: 60 });
    if (!SUBMIT_ANSWERS_RE.test(after)) return;
    await herdr.agentSend(paneId, "1");
  },

  async answerPlanFeedback(herdr, paneId, optionNum, text) {
    // Verified mechanics: send the option's digit to move the cursor there,
    // type the feedback — which replaces the option's placeholder label
    // inline — then Enter, which refines the plan and stays in plan mode.
    await herdr.agentSend(paneId, String(optionNum));
    await sleep(200);
    await herdr.agentSend(paneId, text);
    await sleep(200);
    await herdr.paneSendKeys(paneId, "Enter");
  },

  resolvePlanFile,

  modes: {
    ring: MODE_RING,
    aliases: MODE_ALIASES,
    parseCurrent: parseCurrentMode,
    async cycle(herdr, paneId) {
      // herdr's `send-keys shift+tab` is a no-op for Claude Code; the raw
      // CSI Z sequence sent as text does work (verified empirically).
      await herdr.paneSendText(paneId, BACKTAB);
    },
  },

  async runModelCommand(herdr, agent, argsText) {
    return runClaudeSlashCommand(herdr, agent, `/model ${argsText}`);
  },
};
