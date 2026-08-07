import type { HerdrClient } from "../../herdr/client.js";
import type { AgentDriver, BlockedPrompt } from "../driver.js";
import {
  effortLevelKey,
  findCursorRowNum,
  isEffortListScreen,
  modelNameKey,
  parseCodexMenu,
  parseCodexTrustPrompt,
} from "./prompts.js";
import { extractCodexTurnOutput, locateCodexTranscript, type CodexRecord } from "./transcript.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Moves the cursor to `targetNum` via Up/Down arrow presses (computed from
 * the cursor row visible in `paneText`) and confirms with Enter — NOT by
 * typing the row's digit. Verified empirically: typing a digit on Codex's
 * `/model` list screens acts as a combined "jump + confirm", which races
 * through to silently apply a default on whatever screen comes next (e.g.
 * the reasoning-level screen) before the driver can read and answer it.
 * Arrow keys only move the cursor, leaving Enter as the sole confirm.
 */
async function selectRowViaArrows(
  herdr: HerdrClient,
  paneId: string,
  paneText: string,
  targetNum: string,
): Promise<boolean> {
  const current = findCursorRowNum(paneText);
  if (current === null) return false;
  const delta = parseInt(targetNum, 10) - current;
  const key = delta > 0 ? "Down" : "Up";
  for (let i = 0; i < Math.abs(delta); i++) {
    await herdr.paneSendKeys(paneId, key);
    await sleep(150);
  }
  await herdr.paneSendKeys(paneId, "Enter");
  return true;
}

const LEVEL_ALIASES: Record<string, string> = {
  low: "low",
  medium: "medium",
  med: "medium",
  high: "high",
  extra: "extra high",
  "extrahigh": "extra high",
  "extra-high": "extra high",
  "extra high": "extra high",
};

/** Splits `argsText` into an optional trailing reasoning-level phrase
 *  ("high", "extra high", ...) and the remaining model-name query words —
 *  levels are matched as a 2-word phrase first ("extra high") so it isn't
 *  mistaken for a 1-word level ("high") with "extra" left dangling in the
 *  model query. */
function splitModelAndLevel(words: string[]): { levelKey: string | null; modelWords: string[] } {
  if (words.length >= 3) {
    const phrase = words.slice(-2).join(" ").toLowerCase();
    const alias = LEVEL_ALIASES[phrase];
    if (alias) return { levelKey: alias, modelWords: words.slice(0, -2) };
  }
  if (words.length >= 2) {
    const last = words[words.length - 1].toLowerCase();
    const alias = LEVEL_ALIASES[last];
    if (alias) return { levelKey: alias, modelWords: words.slice(0, -1) };
  }
  return { levelKey: null, modelWords: words };
}

export const codexDriver: AgentDriver = {
  kind: "codex",
  displayName: "Codex CLI",
  paneReadSource: "visible",

  locateTranscript(cwd, sessionId) {
    return locateCodexTranscript(cwd, sessionId);
  },

  extractTurnOutput(records) {
    return extractCodexTurnOutput(records as CodexRecord[]);
  },

  parseTrustPrompt: parseCodexTrustPrompt,

  parseBlockedPane(paneText): BlockedPrompt {
    // Codex has no AskUserQuestion-equivalent tool and no plan mode — every
    // blocked prompt is a command-approval (or directory-trust) menu.
    const menu = parseCodexMenu(paneText);
    return { kind: "permission", menu, isPlanPrompt: false, planFeedbackOptionNum: undefined };
  },

  async answerOption(herdr, paneId, value) {
    // Verified empirically: unlike Claude Code's permission menu (digit
    // alone submits), Codex's approval/trust/model menus show "Press enter
    // to confirm" — the digit only moves the cursor, Enter is required.
    await herdr.agentSend(paneId, value);
    await sleep(150);
    await herdr.paneSendKeys(paneId, "Enter");
  },

  // No answerQuestionFreeText / answerPlanFeedback / resolvePlanFile — Codex
  // has no AskUserQuestion tool and no plan-file concept.

  modes: null, // no Shift+Tab ring, no plan mode

  async runModelCommand(herdr, agent, argsText) {
    const words = argsText.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      return "⚠️ モデル名を指定してください（例: `model gpt-5.6-sol high`）。";
    }
    const { levelKey, modelWords } = splitModelAndLevel(words);
    const modelQuery = modelWords.join(" ").toLowerCase();
    if (!modelQuery) {
      return "⚠️ モデル名を指定してください。";
    }

    // Atomic submit (see TurnEngine.startTurn) — avoids the send-text/Enter
    // paste race that can leave "/model" sitting unsent in the composer.
    await herdr.agentPrompt(agent.paneId, "/model");
    await sleep(600);

    const stage1Text = await herdr.paneRead(agent.paneId, { source: "visible", lines: 30 });
    const stage1 = parseCodexMenu(stage1Text);
    if (!stage1) {
      return "⚠️ モデル選択メニューを開けませんでした。";
    }

    const match = stage1.choices.find((c) => c.label.toLowerCase().includes(modelQuery));
    if (!match) {
      await herdr.paneSendKeys(agent.paneId, "Escape");
      const candidates = stage1.choices.map((c) => modelNameKey(c.label)).join(", ");
      return `⚠️ モデル「${modelQuery}」が見つかりません。候補: ${candidates}`;
    }
    const modelName = modelNameKey(match.label);

    if (!(await selectRowViaArrows(herdr, agent.paneId, stage1Text, match.num))) {
      return "⚠️ モデル選択メニューのカーソル位置を判別できませんでした。";
    }
    await sleep(500);

    const stage2Text = await herdr.paneRead(agent.paneId, { source: "visible", lines: 30 });
    if (!isEffortListScreen(stage2Text)) {
      // Some models apply immediately with no separate effort screen —
      // the model change (with whatever default effort) is already done.
      return `✅ モデルを ${modelName} に切り替えました。`;
    }
    const stage2 = parseCodexMenu(stage2Text);
    if (!stage2) {
      return `✅ モデルを ${modelName} に切り替えました（推論レベル画面を解析できませんでした）。`;
    }

    if (!levelKey) {
      // No level requested — accept whatever's pre-highlighted (current/default).
      await herdr.paneSendKeys(agent.paneId, "Enter");
      return `✅ モデルを ${modelName} に切り替えました。`;
    }

    const levelMatch = stage2.choices.find((c) => effortLevelKey(c.label) === levelKey);
    if (!levelMatch) {
      await herdr.paneSendKeys(agent.paneId, "Escape");
      const candidates = stage2.choices.map((c) => effortLevelKey(c.label)).join(", ");
      return `⚠️ ${modelName} には「${levelKey}」レベルがありません。候補: ${candidates}`;
    }
    if (!(await selectRowViaArrows(herdr, agent.paneId, stage2Text, levelMatch.num))) {
      return `⚠️ モデルを ${modelName} に切り替えましたが、推論レベル画面のカーソル位置を判別できませんでした。`;
    }
    return `✅ モデルを ${modelName} (${effortLevelKey(levelMatch.label)}) に切り替えました。`;
  },
};
