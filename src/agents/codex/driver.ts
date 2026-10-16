import { basename } from "node:path";

import type { AnswerChannel, Terminals } from "../../backend/index.js";
import { BackendUnavailable, type AgentInfo } from "../../backend/types.js";
import { promptFingerprint } from "../fingerprint.js";
import type {
  AgentDriver,
  BlockedPrompt,
  ModelCommandResult,
  OrcaProcessAccess,
  OrcaProcessIdentity,
  OrcaProcessSession,
} from "../driver.js";
import { descriptorMode, parseDescriptors, soleWriterIdentity, type Descriptor } from "../transcript-writer.js";
import {
  createBlindPermissionPrompt,
  createVerifiedModelMenuPrompt,
  createVerifiedPrompt,
} from "../../backend/prompt.js";
import type { VerifiedModelMenuPrompt } from "../../backend/prompt.js";
import {
  effortLevelKey,
  findCursorRowNum,
  isCodexIdleComposer,
  isModelListScreen,
  isEffortListScreen,
  modelNameKey,
  parseCodexMenu,
  parseCodexStartupPrompt,
  parseCursorLabel as parseCodexCursorLabel,
} from "./prompts.js";
import {
  extractCodexLifecycle,
  extractCodexTurnOutput,
  locateCodexTranscript,
  type CodexRecord,
} from "./transcript.js";

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
  channel: AnswerChannel,
  paneText: string,
  targetNum: string,
  expectedLabel: string,
): Promise<boolean> {
  const current = findCursorRowNum(paneText);
  if (current === null) return false;
  const delta = parseInt(targetNum, 10) - current;
  const key = delta > 0 ? "Down" : "Up";
  for (let i = 0; i < Math.abs(delta); i++) {
    await channel.move(key, 1);
    await sleep(150);
  }
  await channel.confirm(expectedLabel);
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

export const CODEX_ORCA_TERMINAL_ANSWER = "⚠️ Orca 上の Codex の確認には Slack から答えられません。端末で答えてください。";

export const CODEX_THREAD_SWITCHED =
  "⚠️ 端末で Codex の別の会話に切り替わったため、このターンを終えました（部分的な出力のみ）";

export const CODEX_SHARED_SERVER_NOTICE =
  "Codex の会話の記録（rollout）が見つからないため、Orca の Codex をつなげません。まだ最初のメッセージを送っていない Codex は、端末で一度送ってから選び直してください。Codex が共有の background server で動いている場合は、Orca の設定「Run each Codex terminal on its own server」を有効にして起動し直してください";

const ROLLOUT_NAME = /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/iu;

/** The `session_meta` payload on a rollout's first line, or null when the line is not one. */
function sessionMeta(head: string): Record<string, unknown> | null {
  const first = head.split(/\r?\n/u, 1)[0];
  if (!first) return null;
  let record: unknown;
  try {
    record = JSON.parse(first) as unknown;
  } catch {
    return null;
  }
  if (typeof record !== "object" || record === null || Array.isArray(record)) return null;
  const { type, payload } = record as Record<string, unknown>;
  if (type !== "session_meta" || typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }
  return payload as Record<string, unknown>;
}

/**
 * Ties a Codex TUI on Orca to its own rollout: the one rollout the process holds
 * open for writing whose `session_meta` is the user's thread, written by no other
 * process. Measured on 0.162: a TUI running its own app-server (Orca's default,
 * `--no-daemon`) holds its thread's rollout and, once a command is reviewed, a
 * guardian subagent's (`thread_source: "guardian_review"`), which is skipped. A
 * TUI on the shared background server holds none — that server writes every
 * session's rollout — so it gets no binding and is not listed. Neither does a TUI
 * before its first message: it creates its rollout then, not at startup.
 */
async function codexSession(
  process: OrcaProcessIdentity,
  access: OrcaProcessAccess,
): Promise<OrcaProcessSession | null> {
  if (!process.cwd) return null;
  const descriptors = parseDescriptors(
    await access.runSystem("lsof", ["-a", "-p", String(process.pid), "-FftpaDin"]),
  );
  if (!descriptors) return null;

  const threads: Array<{ writer: Descriptor; sessionId: string; meta: Record<string, unknown> }> = [];
  for (const descriptor of descriptors) {
    if (descriptor.pid !== process.pid || !descriptor.name) continue;
    const sessionId = basename(descriptor.name).match(ROLLOUT_NAME)?.[1];
    if (!sessionId) continue;
    const mode = descriptorMode(descriptor);
    if (descriptor.type !== "REG" || (mode !== "w" && mode !== "u")) continue;
    const head = await access.readTranscriptHead(descriptor.name);
    // Not skipped as unreadable: if it is the user's thread, skipping would bind another rollout still open.
    if (!head.includes("\n")) throw new BackendUnavailable(`${descriptor.name}: first line not written yet`);
    const meta = sessionMeta(head);
    if (!meta) return null;
    if (meta.thread_source !== "user") continue;
    threads.push({ writer: descriptor, sessionId, meta });
  }
  if (threads.length !== 1) return null;
  const { writer, sessionId, meta } = threads[0]!;
  if (meta.id !== sessionId || meta.cwd !== process.cwd) return null;

  const identity = await soleWriterIdentity(writer, process.pid, access);
  return identity ? { sessionId, transcriptIdentity: identity } : null;
}

export const codexDriver: AgentDriver = {
  kind: "codex",
  orcaProcess: {
    listable: true,
    sessionUnavailableNotice: CODEX_SHARED_SERVER_NOTICE,
    matchesCommand(command) {
      const [executable] = command.trim().split(/\s+/);
      return basename(executable ?? "") === "codex";
    },
    async session(process, access) {
      try {
        return await codexSession(process, access);
      } catch (error) {
        if (error instanceof BackendUnavailable) throw error;
        return null;
      }
    },
  },

  displayName: "Codex CLI",
  readRegion: "screen",

  locateTranscript(cwd, sessionId) {
    return locateCodexTranscript(cwd, sessionId);
  },

  extractTurnOutput(records) {
    const r = records as CodexRecord[];
    return { ...extractCodexTurnOutput(r), lifecycle: extractCodexLifecycle(r) };
  },
  extractLifecycle(records) {
    return extractCodexLifecycle(records as CodexRecord[]);
  },

  parseStartupPrompt: parseCodexStartupPrompt,

  parseBlockedPane(paneText): BlockedPrompt {
    // Codex has no AskUserQuestion-equivalent tool and no plan mode — every
    // blocked prompt is a command-approval (or directory-trust) menu.
    const menu = parseCodexMenu(paneText);
    if (!menu) {
      return { kind: "blind-permission", blind: createBlindPermissionPrompt(codexDriver, "key-then-enter") };
    }
    const content = { kind: "permission" as const, menu, isPlanPrompt: false };
    const fingerprint = promptFingerprint(content);
    if (fingerprint === null) {
      return { kind: "blind-permission", blind: createBlindPermissionPrompt(codexDriver, "key-then-enter") };
    }
    return {
      ...content,
      verified: createVerifiedPrompt(fingerprint, codexDriver, "digit-then-enter"),
    };
  },
  parseCursorLabel(snap) {
    return snap.complete ? parseCodexCursorLabel(snap.text) : null;
  },
  isIdleComposer: isCodexIdleComposer,

  async answerOption(channel, value, expectedLabel) {
    // Verified empirically: unlike Claude Code's permission menu (digit
    // alone submits), Codex's approval/trust/model menus show "Press enter
    // to confirm" — the digit only moves the cursor, Enter is required.
    await channel.digit(Number(value));
    await sleep(150);
    await channel.confirm(expectedLabel);
  },

  // No answerQuestionFreeText / answerPlanFeedback / resolvePlanFile — Codex
  // has no AskUserQuestion tool and no plan-file concept.

  modes: null, // no Shift+Tab ring, no plan mode

  async runModelCommand(terminals, agent, argsText): Promise<ModelCommandResult> {
    const result = (reply: string, submitOutcome: ModelCommandResult["submitOutcome"] = null) => ({
      reply,
      submitOutcome,
    });
    if (agent.backend === "orca") {
      // Refused before /model is sent: Orca has no Escape-capable channel to back out of the menu.
      return result("⚠️ Orca 上の Codex のモデルは、端末で /model から変えてください。");
    }
    const words = argsText.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      return result("⚠️ モデル名を指定してください（例: `model gpt-5.6-sol high`）。");
    }
    const { levelKey, modelWords } = splitModelAndLevel(words);
    const modelQuery = modelWords.join(" ").toLowerCase();
    if (!modelQuery) {
      return result("⚠️ モデル名を指定してください。");
    }

    // Atomic submit (see TurnEngine.startTurn) — avoids the send-text/Enter
    // paste race that can leave "/model" sitting unsent in the composer.
    const submitOutcome = await terminals.submit(agent.ref, "/model", {
      driver: codexDriver,
      cancelled: () => false,
      transcriptGrew: () => false,
      retryLimit: 0,
      pollIntervalMs: 0,
    });
    await sleep(600);

    const stage1Text = (await terminals.read(agent.ref.target, 30, "screen")).text;
    const stage1 = parseCodexMenu(stage1Text);
    if (!stage1) {
      return result("⚠️ モデル選択メニューを開けませんでした。", submitOutcome);
    }
    const firstPrompt = parseCodexModelMenuPrompt(stage1Text);
    if (!firstPrompt) {
      return result("⚠️ モデル選択メニューを開けませんでした。", submitOutcome);
    }
    const firstChannel = terminals.openModelAnswer(agent.ref, firstPrompt);

    const match = stage1.choices.find((c) => c.label.toLowerCase().includes(modelQuery));
    if (!match) {
      await firstChannel.escape();
      const candidates = stage1.choices.map((c) => modelNameKey(c.label)).join(", ");
      return result(`⚠️ モデル「${modelQuery}」が見つかりません。候補: ${candidates}`, submitOutcome);
    }
    const modelName = modelNameKey(match.label);

    if (!(await selectRowViaArrows(firstChannel, stage1Text, match.num, match.label))) {
      return result("⚠️ モデル選択メニューのカーソル位置を判別できませんでした。", submitOutcome);
    }
    await sleep(500);

    const stage2Text = (await terminals.read(agent.ref.target, 30, "screen")).text;
    if (!isEffortListScreen(stage2Text)) {
      // Some models apply immediately with no separate effort screen —
      // the model change (with whatever default effort) is already done.
      return result(`✅ モデルを ${modelName} に切り替えました。`, submitOutcome);
    }
    const stage2 = parseCodexMenu(stage2Text);
    if (!stage2) {
      return result(`✅ モデルを ${modelName} に切り替えました（推論レベル画面を解析できませんでした）。`, submitOutcome);
    }
    const secondPrompt = parseCodexModelMenuPrompt(stage2Text);
    if (!secondPrompt) {
      return result(`✅ モデルを ${modelName} に切り替えました（推論レベル画面を解析できませんでした）。`, submitOutcome);
    }
    const secondChannel = terminals.openModelAnswer(agent.ref, secondPrompt);

    if (!levelKey) {
      // No level requested — accept whatever's pre-highlighted (current/default).
      const selectedLabel = codexDriver.parseCursorLabel({
        text: stage2Text,
        draft: null,
        complete: true,
      });
      if (selectedLabel === null) {
        return result(
          `⚠️ モデルを ${modelName} に切り替えましたが、推論レベル画面のカーソル位置を判別できませんでした。`,
          submitOutcome,
        );
      }
      await secondChannel.confirm(selectedLabel);
      return result(`✅ モデルを ${modelName} に切り替えました。`, submitOutcome);
    }

    const levelMatch = stage2.choices.find((c) => effortLevelKey(c.label) === levelKey);
    if (!levelMatch) {
      await secondChannel.escape();
      const candidates = stage2.choices.map((c) => effortLevelKey(c.label)).join(", ");
      return result(`⚠️ ${modelName} には「${levelKey}」レベルがありません。候補: ${candidates}`, submitOutcome);
    }
    if (!(await selectRowViaArrows(secondChannel, stage2Text, levelMatch.num, levelMatch.label))) {
      return result(
        `⚠️ モデルを ${modelName} に切り替えましたが、推論レベル画面のカーソル位置を判別できませんでした。`,
        submitOutcome,
      );
    }
    return result(`✅ モデルを ${modelName} (${effortLevelKey(levelMatch.label)}) に切り替えました。`, submitOutcome);
  },
};

export function parseCodexModelMenuPrompt(paneText: string): VerifiedModelMenuPrompt | null {
  if (!isModelListScreen(paneText) && !isEffortListScreen(paneText)) return null;
  const menu = parseCodexMenu(paneText);
  if (!menu) return null;
  const fingerprint = promptFingerprint({ kind: "permission" as const, menu, isPlanPrompt: false });
  return fingerprint === null ? null : createVerifiedModelMenuPrompt(fingerprint, codexDriver);
}
