import type { AgentDriver, BlockedPrompt } from "../driver.js";
import type { HerdrClient } from "../../herdr/client.js";
import {
  BACKTAB,
  findPlanFeedbackOption,
  MODE_ALIASES,
  MODE_RING,
  parseAskUserQuestionPane,
  parseCurrentMode,
  parsePermissionMenu,
  stripFooterChrome,
} from "./prompts.js";
import {
  extractAssistantText,
  extractSendUserFileRequests,
  extractToolOutcomes,
  extractToolUseSummaries,
  locateClaudeTranscript,
  type TranscriptRecord,
} from "./transcript.js";
import { resolvePlanFile } from "./plan.js";

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
      sendFileRequests: extractSendUserFileRequests(r),
      toolOutcomes: extractToolOutcomes(r),
    };
  },

  parseBlockedPane(paneText): BlockedPrompt {
    const aq = parseAskUserQuestionPane(paneText);
    if (aq) return { kind: "question", info: aq };
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

  async answerQuestionFreeText(herdr, paneId, info, text) {
    // Navigate down to the "Type something" row (the free-text row must be
    // reached via arrows and then have its placeholder replaced before Enter).
    const downs = Array(info.options.length).fill("Down");
    if (downs.length) await herdr.paneSendKeys(paneId, ...downs);
    await herdr.agentSend(paneId, text);
    await sleep(200);
    await herdr.paneSendKeys(paneId, "Enter");
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
