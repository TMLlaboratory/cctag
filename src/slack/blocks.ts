import type { AgentInfo } from "../herdr/types.js";
import type { AskUserQuestionPaneInfo, PermissionMenu } from "../agents/driver.js";
import { isDangerousSnippet, isRefusalLabel } from "../agents/driver.js";
import type { MarkdownTable } from "./mrkdwn.js";

const STATUS_ICON: Record<string, string> = {
  idle: "🟢",
  working: "🟡",
  blocked: "🔴",
  done: "🟢",
  unknown: "⚪",
};

function truncateLeft(s: string, max: number): string {
  if (s.length <= max) return s;
  return "…" + s.slice(s.length - max + 1);
}

function dirLabel(cwd: string): string {
  const base = cwd.replace(/\/+$/, "").split("/").pop();
  return base && base.length > 0 ? base : cwd;
}

/**
 * A static_select of currently running herdr agents, for `@cctag connect`.
 *
 * Grouped by cwd via Slack's native `option_groups`: one header per project
 * directory, one row per session underneath — mirroring the Claude Code
 * app's own session picker (folder name, then each session's title) instead
 * of a flat list of full paths that gave no way to tell two sessions in the
 * same directory apart at a glance. The title itself is `terminalTitle`,
 * herdr's live read of the pane's own tab title — not re-derived from the
 * session transcript, which isn't guaranteed to contain one (verified: a
 * long-running session with a title visible in its tab had zero title
 * records in a 13MB transcript).
 */
export function agentPickerBlocks(agents: AgentInfo[]) {
  if (agents.length === 0) {
    return [
      {
        type: "section",
        text: { type: "mrkdwn", text: "現在 herdr 上で稼働中のインスタンスが見つかりません。" },
      },
    ];
  }

  const groups = new Map<string, AgentInfo[]>();
  for (const a of agents) {
    const list = groups.get(a.cwd);
    if (list) list.push(a);
    else groups.set(a.cwd, [a]);
  }

  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: "*接続するインスタンスを選択してください:*" },
      accessory: {
        type: "static_select",
        action_id: "pair_select",
        placeholder: { type: "plain_text", text: "インスタンスを選択" },
        option_groups: [...groups.entries()].map(([cwd, group]) => ({
          label: { type: "plain_text", text: dirLabel(cwd).slice(0, 75) },
          options: group.map((a) => {
            const prefix = a.agent && a.agent !== "claude" ? `[${a.agent}] ` : "";
            const label = a.terminalTitle ?? a.name ?? a.paneId;
            return {
              text: {
                type: "plain_text",
                text: `${STATUS_ICON[a.agentStatus] ?? "⚪"} ${prefix}${label}`.slice(0, 75),
              },
              value: a.paneId,
            };
          }),
        })),
      },
    },
  ];
}

export function statusText(agent: AgentInfo | null, elapsedSec?: number, lastTool?: string): string {
  if (!agent) return "⚠️ インスタンスが見つかりません";
  if (agent.agentStatus === "blocked") return "⏸ 応答待ち…";
  const suffix = lastTool ? ` — 🔧 ${lastTool}` : "";
  const time = elapsedSec !== undefined ? ` (${elapsedSec}s)` : "";
  return `⚙️ 実行中…${time}${suffix}`;
}

export function doneStatusText(elapsedSec: number, toolCounts: Record<string, number>): string {
  const parts = Object.entries(toolCounts).map(([name, n]) => `${name}×${n}`);
  const suffix = parts.length ? ` — 🔧 ${parts.join(", ")}` : "";
  return `✅ 完了 (${elapsedSec}s)${suffix}`;
}

interface AqButtonValue {
  k: "aq";
  t: string; // paneId (herdr agent-command target — see pairing.ts)
  p: number; // promptId (race guard — this prompt's slot in the turn)
  o: number; // option index
}

/**
 * The multi-select submit button's payload. It carries no selection: what is
 * ticked lives in Slack's own `state`, read at click time by
 * selectedOptionIndices, because a button's value is fixed when the message is
 * built and the boxes are ticked long after that.
 */
interface AqMultiButtonValue {
  k: "aqm";
  t: string;
  p: number;
}

/** Ticked by the reader; carries no submit of its own. */
export const AQ_MULTI_CHECKBOX_ACTION_ID = "aq_multi_select";
/** Named to fall under the `aq_answer_` prefix both routers already match. */
export const AQ_MULTI_SUBMIT_ACTION_ID = "aq_answer_multi";

/** Slack's own cap on a checkboxes element. AskUserQuestion offers at most four
 *  options today, so this is headroom rather than a limit anyone should hit. */
const MAX_CHECKBOX_OPTIONS = 10;
/** Slack rejects a checkbox option's text past 75 characters — see the comment
 *  at the options map for why that is a hard failure and not a truncation. */
const CHECKBOX_LABEL_MAX = 75;

function checkboxLabel(num: number, label: string): string {
  const prefix = `${num}. `;
  const room = CHECKBOX_LABEL_MAX - prefix.length;
  return prefix + (label.length > room ? `${label.slice(0, room - 1)}…` : label);
}

/**
 * The submit button's value with the ticked boxes folded into it, for relaying
 * to a Spoke over the one `aq_answer` call that already exists.
 *
 * A Hub too old to know about this leaves the value alone, so the field is
 * simply absent on arrival — which the Spoke reports as "the Hub needs
 * updating" rather than as an empty selection. Anything that is not the
 * multi-select submit passes through untouched.
 */
export function withSelectedIndices(raw: string, body: unknown): string {
  let parsed: { k?: string };
  try {
    parsed = JSON.parse(raw) as { k?: string };
  } catch {
    return raw;
  }
  if (parsed.k !== "aqm") return raw;
  return JSON.stringify({ ...parsed, s: selectedOptionIndices(body) ?? undefined });
}

/**
 * The option indices ticked in a checkboxes element, out of a `block_actions`
 * body.
 *
 * Lives beside the builder above on purpose: the `value` strings it reads are
 * the ones that builder wrote, and a change to one is a change to the other.
 * Scans every block rather than keying off a block_id, since Slack assigns
 * block ids itself when the message doesn't set them.
 *
 * Returns null when the element isn't in the body at all — which is how an
 * older Hub, one that relays the click without Slack's `state`, is told apart
 * from a reader who ticked nothing.
 */
export function selectedOptionIndices(body: unknown): number[] | null {
  const values = (body as { state?: { values?: Record<string, Record<string, unknown>> } })?.state?.values;
  if (!values) return null;
  for (const block of Object.values(values)) {
    const element = block?.[AQ_MULTI_CHECKBOX_ACTION_ID] as
      | { selected_options?: Array<{ value?: string }> }
      | undefined;
    if (!element) continue;
    return (element.selected_options ?? [])
      .map((o) => Number(o.value))
      .filter((n) => Number.isInteger(n) && n >= 0)
      .sort((a, b) => a - b);
  }
  return null;
}

/** Renders an AskUserQuestion prompt read off the pane (one question at a time). */
export function askUserQuestionBlocks(paneId: string, promptId: number, info: AskUserQuestionPaneInfo) {
  const header = `❓ ${info.header}`;
  const blocks: unknown[] = [{ type: "section", text: { type: "mrkdwn", text: `*${header}*\n${info.question}` } }];

  if (info.multiSelect) {
    // Until 2026-08-31 this branch returned here with no interactive element at
    // all — a numbered list and "reply in free text". Reported from production:
    // question 1 of a four-question dialog was answered from Slack by button and
    // question 2, the multi-select one, offered nothing to press, so the whole
    // dialog got finished at the keyboard instead. Slack has had a checkboxes
    // element the whole time; the gap was cctag's.
    const shown = info.options.slice(0, MAX_CHECKBOX_OPTIONS);
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*複数選択できます。* 選んで「送信」を押すか、このスレッドに「1,3」のように番号で返信してください。\n${info.options
          .map((o, i) => `*${i + 1}.* ${o.label}${o.description ? `\n    ${o.description}` : ""}`)
          .join("\n")}`,
      },
    });
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "checkboxes",
          action_id: AQ_MULTI_CHECKBOX_ACTION_ID,
          // Number and label only. A checkbox option's text and description cap
          // at 75 characters each, and the descriptions here routinely run past
          // 100 — an over-long field is not truncated by Slack, it rejects the
          // whole message as invalid_blocks and cctag falls back to plain text,
          // which is the very failure this branch exists to end. The full text
          // is in the section above, so nothing is lost by keeping these short.
          options: shown.map((o, i) => ({
            text: { type: "plain_text", text: checkboxLabel(i + 1, o.label) },
            value: String(i),
          })),
        },
        {
          type: "button",
          text: { type: "plain_text", text: "送信" },
          style: "primary",
          value: JSON.stringify({ k: "aqm", t: paneId, p: promptId } satisfies AqMultiButtonValue),
          // Deliberately under the aq_answer_ prefix the routers already match,
          // so no new route is needed on either the Hub or the standalone app.
          action_id: AQ_MULTI_SUBMIT_ACTION_ID,
        },
      ],
    });
    const hiddenBoxes = info.options.length - shown.length;
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text:
            hiddenBoxes > 0
              ? `チェックボックスは${MAX_CHECKBOX_OPTIONS}件までです。残り${hiddenBoxes}件を選ぶ場合は、このスレッドに返信してください`
              : "番号以外の返信は、そのまま自由記述の回答として渡されます",
        },
      ],
    });
    return blocks;
  }

  // Long options belong in the message, not on the buttons. A button caps at 75
  // characters and does not wrap, so a paragraph-length choice arrived as an
  // unreadable slab with its distinguishing part cut off — reported from a real
  // prompt whose four options each ran past a hundred characters. The full text
  // goes in a numbered list, and the buttons carry just enough to match a number
  // to what it means.
  const needsList = info.options.some((o) => o.label.length > BUTTON_LABEL_BUDGET || o.description);
  if (needsList) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: info.options
          .map((o, i) => `*${i + 1}.* ${o.label}${o.description ? `\n    ${o.description}` : ""}`)
          .join("\n"),
      },
    });
  }

  const shown = info.options.slice(0, MAX_OPTION_BUTTONS);
  blocks.push({
    type: "actions",
    elements: shown.map((o, i) => ({
      type: "button",
      text: { type: "plain_text", text: buttonLabel(i + 1, o.label) },
      value: JSON.stringify({ k: "aq", t: paneId, p: promptId, o: i } satisfies AqButtonValue),
      action_id: `aq_answer_${i}`,
    })),
  });

  // Said out loud rather than left to be noticed. Options past the button limit
  // used to be dropped in silence, so a prompt with more of them looked as though
  // it had fewer — and the missing ones were unanswerable.
  const hidden = info.options.length - shown.length;
  const hint =
    hidden > 0
      ? `ボタンは${MAX_OPTION_BUTTONS}件までです。残り${hidden}件を選ぶ場合や自由に答える場合は、このスレッドに返信してください`
      : "ボタンを押すか、このスレッドに返信すると自由記述で回答できます";
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: hint }] });
  return blocks;
}

/** How much of an option's own words a button carries. Slack's own cap is 75 and
 *  buttons do not wrap, so the useful limit is whatever stays scannable. */
const BUTTON_LABEL_BUDGET = 24;
/** Buttons per prompt. Slack allows more, but a row of them stops being readable
 *  — and the numbered list above carries every option regardless. */
const MAX_OPTION_BUTTONS = 5;

function buttonLabel(num: number, label: string): string {
  const head = label.length > BUTTON_LABEL_BUDGET ? `${label.slice(0, BUTTON_LABEL_BUDGET - 1)}…` : label;
  return `${num}. ${head}`.slice(0, 75);
}

export function askUserQuestionAnsweredText(header: string, answer: string, actor?: string): string {
  return `✅ *${header}* → ${answer}${actor ? `（${actor}）` : ""}`;
}

interface PermButtonValue {
  k: "perm";
  t: string;
  p: number;
  n: string;
}

export function permissionBlocks(paneId: string, promptId: number, menu: PermissionMenu, headerOverride?: string) {
  const danger = isDangerousSnippet(menu.snippet);
  const header = headerOverride ?? (danger ? "🚨 許可リクエスト（危険な可能性）" : "⚠️ 許可リクエスト");
  const blocks: unknown[] = [
    { type: "section", text: { type: "mrkdwn", text: `*${header}*` } },
    { type: "section", text: { type: "mrkdwn", text: "```\n" + menu.snippet.slice(0, 2900) + "\n```" } },
    {
      type: "actions",
      elements: menu.choices.slice(0, 5).map((c) => ({
        type: "button",
        text: { type: "plain_text", text: `${c.num}. ${c.label}`.slice(0, 75) },
        style: c.num === "1" ? "primary" : isRefusalLabel(c.label) ? "danger" : undefined,
        value: JSON.stringify({ k: "perm", t: paneId, p: promptId, n: c.num } satisfies PermButtonValue),
        action_id: `perm_choice_${c.num}`,
      })),
    },
  ];
  return blocks;
}

/**
 * A question dialog cctag could not read, shown without any answer buttons.
 *
 * The parse-failure fallback below offers ✅/❌ because an unreadable
 * *permission* menu still accepts y/n. A question does not: its options are a
 * numbered — often multi-select — list, where `y` means nothing and can toggle
 * or submit a choice nobody made. So this path shows the screen and asks for a
 * keyboard answer instead of guessing. cctag notices the answer either way —
 * the pane leaves `blocked`, and the poll loop updates this message to say it
 * was answered at the terminal.
 */
export function unreadableQuestionBlocks(rawSnippet: string) {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          "⚠️ 質問が表示されていますが、選択肢を読み取れませんでした。" +
          "誤ったキーを送らないよう、ボタンは出していません — *ターミナルで直接回答してください*。",
      },
    },
    { type: "section", text: { type: "mrkdwn", text: "```\n" + rawSnippet.slice(0, 2900) + "\n```" } },
  ];
}

export function permissionParseFailureBlocks(paneId: string, promptId: number, rawSnippet: string) {
  return [
    { type: "section", text: { type: "mrkdwn", text: "⚠️ 許可リクエスト（メニューを解析できませんでした）" } },
    { type: "section", text: { type: "mrkdwn", text: "```\n" + rawSnippet.slice(0, 2900) + "\n```" } },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "✅ 承認 (y)" },
          style: "primary",
          value: JSON.stringify({ k: "perm", t: paneId, p: promptId, n: "y" } satisfies PermButtonValue),
          action_id: "perm_choice_y",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "❌ 拒否 (n)" },
          style: "danger",
          value: JSON.stringify({ k: "perm", t: paneId, p: promptId, n: "n" } satisfies PermButtonValue),
          action_id: "perm_choice_n",
        },
      ],
    },
  ];
}

// --- Markdown tables as Block Kit table blocks ------------------------------
//
// Documented caps for a table block. Verified empirically that the two limits
// folklore also claims — one table per message, and a table having to be the
// last block — do NOT exist: [section, table, section, table] and
// [section, table, section] both post fine. So prose and tables interleave in
// one message and only these caps force a fallback.
const TABLE_MAX_ROWS = 100;
const TABLE_MAX_COLS = 20;
const TABLE_MAX_CHARS = 10_000;

/**
 * Inline Markdown inside one cell, as rich_text elements.
 *
 * Bold, italic, code and links all render inside a cell — verified against a
 * live workspace, contrary to references claiming cells are plain text only.
 * Code spans are matched first so formatting characters inside `like_this`
 * stay literal.
 */
function cellElements(md: string): unknown[] {
  const elements: unknown[] = [];
  const pattern = /`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*]+)\*\*|\*([^*]+)\*|_([^_]+)_/g;
  let last = 0;
  for (let m = pattern.exec(md); m !== null; m = pattern.exec(md)) {
    if (m.index > last) elements.push({ type: "text", text: md.slice(last, m.index) });
    if (m[1] !== undefined) elements.push({ type: "text", text: m[1], style: { code: true } });
    else if (m[2] !== undefined) elements.push({ type: "link", url: m[3], text: m[2] });
    else if (m[4] !== undefined) elements.push({ type: "text", text: m[4], style: { bold: true } });
    else if (m[5] !== undefined) elements.push({ type: "text", text: m[5], style: { italic: true } });
    else if (m[6] !== undefined) elements.push({ type: "text", text: m[6], style: { italic: true } });
    last = m.index + m[0].length;
  }
  if (last < md.length) elements.push({ type: "text", text: md.slice(last) });
  // An empty cell still needs a node, or the row is ragged to Slack.
  if (elements.length === 0) elements.push({ type: "text", text: " " });
  return elements;
}

function cell(md: string): unknown {
  return { type: "rich_text", elements: [{ type: "rich_text_section", elements: cellElements(md) }] };
}

/**
 * A table block for `table`, or null when it exceeds what a table block holds.
 *
 * Returning null rather than throwing or truncating is deliberate: the caller
 * falls back to posting the table as ordinary mrkdwn text, which is ugly but
 * loses nothing. Silently dropping rows would be the worst outcome — the reader
 * can't tell a trimmed table from a complete one.
 */
export function markdownTableBlock(table: MarkdownTable): unknown | null {
  const all = [table.header, ...table.rows];
  if (all.length === 0 || table.header.length === 0) return null;
  if (all.length > TABLE_MAX_ROWS || table.header.length > TABLE_MAX_COLS) return null;
  const chars = all.reduce((sum, row) => sum + row.reduce((n, c) => n + c.length, 0), 0);
  if (chars > TABLE_MAX_CHARS) return null;
  return { type: "table", rows: all.map((row) => row.map(cell)) };
}

/** The mrkdwn fallback for a table too big for a table block: a monospace grid,
 *  which at least keeps the columns readable. */
export function markdownTableFallback(table: MarkdownTable): string {
  const all = [table.header, ...table.rows];
  const widths = table.header.map((_, i) => Math.max(...all.map((r) => (r[i] ?? "").length)));
  const line = (row: string[]): string => row.map((c, i) => (c ?? "").padEnd(widths[i])).join("  ").trimEnd();
  return ["```", line(table.header), widths.map((w) => "-".repeat(w)).join("  "), ...table.rows.map(line), "```"].join("\n");
}
