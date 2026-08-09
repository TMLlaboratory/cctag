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

/** Renders an AskUserQuestion prompt read off the pane (one question at a time). */
export function askUserQuestionBlocks(paneId: string, promptId: number, info: AskUserQuestionPaneInfo) {
  const header = `❓ ${info.header}`;
  const blocks: unknown[] = [{ type: "section", text: { type: "mrkdwn", text: `*${header}*\n${info.question}` } }];

  if (info.multiSelect) {
    const optionLines = info.options.map(
      (o, i) => `${i + 1}. *${o.label}*${o.description ? ` — ${o.description}` : ""}`,
    );
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `複数選択可能な質問です。このスレッドへの返信で、選びたい項目をまとめて自由記述で答えてください:\n${optionLines.join("\n")}`,
      },
    });
    return blocks;
  }

  blocks.push({
    type: "actions",
    elements: info.options.slice(0, 4).map((o, i) => ({
      type: "button",
      text: { type: "plain_text", text: `${i + 1}. ${o.label}`.slice(0, 75) },
      value: JSON.stringify({ k: "aq", t: paneId, p: promptId, o: i } satisfies AqButtonValue),
      action_id: `aq_answer_${i}`,
    })),
  });
  const descriptions = info.options
    .map((o, i) => (o.description ? `${i + 1}. ${o.description}` : null))
    .filter(Boolean);
  if (descriptions.length) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: descriptions.join(" ／ ") }] });
  }
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: "ボタンを押すか、このスレッドに返信すると自由記述で回答できます" }],
  });
  return blocks;
}

export function askUserQuestionAnsweredText(header: string, answer: string): string {
  return `✅ *${header}* → ${answer}`;
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
