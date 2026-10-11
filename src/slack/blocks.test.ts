import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agentPickerBlocks,
  AQ_MULTI_CHECKBOX_ACTION_ID,
  AQ_MULTI_SUBMIT_ACTION_ID,
  askUserQuestionBlocks,
  selectedOptionIndices,
  withSelectedIndices,
} from "./blocks.js";
import type { AskUserQuestionPaneInfo } from "../agents/driver.js";
import type { AgentInfo, AgentStatus, BackendName, ListResult } from "../backend/types.js";

/** Every element of a given type anywhere in the blocks, flattened. */
function elementsOfType(blocks: unknown[], type: string): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  for (const block of blocks as Array<{ type?: string; elements?: unknown[] }>) {
    for (const el of (block.elements ?? []) as Array<Record<string, unknown>>) {
      if (el.type === type) found.push(el);
    }
  }
  return found;
}

function textOf(blocks: unknown[]): string {
  return JSON.stringify(blocks);
}

const MULTI: AskUserQuestionPaneInfo = {
  header: "削る場所",
  question: "6ページ制約が既にぎりぎりです。どこから捻出しますか？",
  multiSelect: true,
  options: [
    { label: "§2.1「橋渡し」を圧縮 (推奨)", description: "現在10行。新設する段落と重複するので4-5行に圧縮し、5-6行を捻出。" },
    { label: "§6.2「モデルの大きさ」を圧縮", description: "現在14行。査読者の当然の反論への防御。8行程度に圧縮して6行捻出できるが、防御が薄くなる。" },
    { label: "§5.3の処理時間の記述を圧縮", description: "現在11行。2機種の符号化・復号時間の内訳を簡略化して3行程度捻出。" },
    { label: "§4.2の仕様itemizeを散文化", description: "現在11行の4項目。貢献を支える具体物なので、圧縮すると貢献が抽象的になるリスクあり。" },
  ],
};

const SINGLE: AskUserQuestionPaneInfo = {
  header: "起源の配置",
  question: "QRコードの起源をどこに置きますか？",
  multiSelect: false,
  options: [{ label: "§1冒頭の1段落 (推奨)" }, { label: "§2.1の冒頭に置く" }, { label: "§2.2 表1の前フリに置く" }],
};

test("a multi-select question offers checkboxes and a submit button", () => {
  // The production report this fixes: question 1 of a four-question dialog was
  // answered from Slack by button, and question 2 — the multi-select one —
  // offered nothing to press at all, because this branch used to return a
  // numbered list and "reply in free text" with no interactive element.
  const blocks = askUserQuestionBlocks("wY:p1", 3, MULTI);
  const boxes = elementsOfType(blocks, "checkboxes");
  assert.equal(boxes.length, 1, "a multi-select question must be answerable from Slack");
  assert.equal(boxes[0].action_id, AQ_MULTI_CHECKBOX_ACTION_ID);
  assert.equal((boxes[0].options as unknown[]).length, 4);

  const buttons = elementsOfType(blocks, "button");
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].action_id, AQ_MULTI_SUBMIT_ACTION_ID);
  assert.deepEqual(JSON.parse(buttons[0].value as string), { k: "aqm", t: "wY:p1", p: 3 });
});

test("the submit button's action_id stays under the prefix the routers match", () => {
  // Both the Hub and the standalone app route question answers by
  // /^aq_answer_/. Renaming this to something outside that prefix would leave
  // the button unhandled — Slack shows the reader a warning and nothing is sent.
  assert.ok(AQ_MULTI_SUBMIT_ACTION_ID.startsWith("aq_answer_"));
  assert.ok(!AQ_MULTI_CHECKBOX_ACTION_ID.startsWith("aq_answer_"), "a tick must not be routed as a submit");
});

test("checkbox labels stay inside Slack's 75-character cap", () => {
  // Not cosmetic: Slack rejects the whole message as invalid_blocks when an
  // option's text runs long, and cctag then falls back to plain text — which is
  // exactly the "no buttons appeared" failure this branch exists to end. The
  // descriptions here run past 75 on their own, so they stay out of the boxes.
  const long: AskUserQuestionPaneInfo = {
    ...MULTI,
    options: MULTI.options.map((o) => ({ label: `${o.label}${"あ".repeat(200)}`, description: o.description })),
  };
  for (const box of elementsOfType(askUserQuestionBlocks("w:p1", 1, long), "checkboxes")) {
    for (const opt of box.options as Array<{ text: { text: string }; description?: unknown }>) {
      assert.ok(opt.text.text.length <= 75, `option text was ${opt.text.text.length} chars`);
      assert.equal(opt.description, undefined, "a description would carry the same risk with no benefit");
    }
  }
});

test("the full option text is still in the message, so nothing is lost to the cap", () => {
  const rendered = textOf(askUserQuestionBlocks("w:p1", 1, MULTI));
  for (const o of MULTI.options) {
    assert.ok(rendered.includes(o.label), `missing label: ${o.label}`);
    assert.ok(rendered.includes(o.description!), `missing description: ${o.description}`);
  }
});

test("a single-select question is unchanged: buttons, no checkboxes", () => {
  const blocks = askUserQuestionBlocks("w:p1", 1, SINGLE);
  assert.equal(elementsOfType(blocks, "checkboxes").length, 0);
  assert.equal(elementsOfType(blocks, "button").length, 3);
});

// --- reading the ticked boxes back out of Slack's payload -------------------

function bodyWithSelections(values: string[]): unknown {
  return {
    state: { values: { someBlockId: { [AQ_MULTI_CHECKBOX_ACTION_ID]: { type: "checkboxes", selected_options: values.map((v) => ({ value: v })) } } } },
  };
}

test("ticked boxes are read out of Slack's state, sorted", () => {
  assert.deepEqual(selectedOptionIndices(bodyWithSelections(["2", "0"])), [0, 2]);
});

test("ticking nothing reads as an empty selection, not as a missing one", () => {
  // The difference decides which reply the reader gets: "pick at least one"
  // versus "the Hub needs updating".
  assert.deepEqual(selectedOptionIndices(bodyWithSelections([])), []);
  assert.equal(selectedOptionIndices({ state: { values: {} } }), null);
  assert.equal(selectedOptionIndices({}), null, "a body with no state at all is a relay that cannot carry one");
});

test("the selection is folded into the value relayed to the Spoke", () => {
  const raw = JSON.stringify({ k: "aqm", t: "wY:p1", p: 3 });
  assert.deepEqual(JSON.parse(withSelectedIndices(raw, bodyWithSelections(["1", "3"]))), {
    k: "aqm",
    t: "wY:p1",
    p: 3,
    s: [1, 3],
  });
});

test("a Hub that cannot carry a selection leaves the field absent rather than empty", () => {
  const raw = JSON.stringify({ k: "aqm", t: "wY:p1", p: 3 });
  assert.equal("s" in JSON.parse(withSelectedIndices(raw, {})), false);
});

test("anything that is not the multi-select submit passes through untouched", () => {
  const single = JSON.stringify({ k: "aq", t: "w:p1", p: 1, o: 2 });
  assert.equal(withSelectedIndices(single, bodyWithSelections(["0"])), single);
  assert.equal(withSelectedIndices("not json at all", {}), "not json at all");
});

test("the agent picker groups by backend and cwd with readable title-less Orca labels", () => {
  const agent = (
    target: string,
    backend: BackendName,
    cwd: string,
    agentKind: AgentInfo["agent"],
    status: AgentStatus,
    terminalTitle: string | null,
    displayId: string,
    pickerState: string | null = null,
  ): AgentInfo => ({
    ref: { target, pid: null, processStartedAt: null },
    backend,
    agent: agentKind,
    sessionId: null,
    cwd,
    evidence: { kind: "classified", status },
    terminalTitle,
    terminalId: "herdr-terminal-id",
    displayId,
    pickerState,
  });
  const paneKey = "e89f6036-1062-4bbf-9a11-86aab4cc3f47";
  const orcaTarget = `orca:${paneKey}`;
  const result: ListResult = {
    agents: [
      agent("wT:p1", "herdr", "/work/project", "claude", "idle", "Claude session", "pane-1"),
      agent("wT:p2", "herdr", "/work/project", "codex", "working", null, "pane-2"),
      agent(orcaTarget, "orca", "/work/project", "claude", "working", null, orcaTarget, "waiting"),
      agent("orca:omp-pane", "orca", "/work/project", "omp", "working", "OMP session", "omp-pane"),
    ],
    failures: [],
    complete: true,
    notices: [],
  };
  const blocks = agentPickerBlocks(result, ["herdr", "orca"]) as unknown as Array<{
    accessory: {
      option_groups: Array<{
        label: { text: string };
        options: Array<{ text: { text: string }; value: string }>;
      }>;
    };
  }>;
  const groups = blocks[0]!.accessory.option_groups;
  assert.deepEqual(groups.map((group) => group.label.text), ["herdr · project", "orca · project"]);
  assert.deepEqual(groups[0]!.options.map((option) => option.value), ["wT:p1", "wT:p2"]);
  assert.deepEqual(groups[0]!.options.map((option) => option.text.text), [
    "🟢 Claude session",
    "🟡 [codex] pane-2",
  ]);
  assert.deepEqual(groups[1]!.options.map((option) => option.value), [orcaTarget, "orca:omp-pane"]);
  assert.deepEqual(groups[1]!.options.map((option) => option.text.text), [
    "🔴 Claude Code · e89f6036",
    "⚪ [omp] OMP session",
  ]);
});

test("Orca picker icons use only recognized worktree states", () => {
  const states = [
    ["working", "🟡"],
    ["waiting", "🔴"],
    ["blocked", "🔴"],
    ["done", "🟢"],
    ["idle", "🟢"],
    ["unrecognized", "⚪"],
    [null, "⚪"],
  ] as const;
  const result: ListResult = {
    agents: states.map(([pickerState], index) => ({
      ref: { target: `orca:pane-${index}`, pid: null, processStartedAt: null },
      backend: "orca",
      agent: "claude",
      sessionId: null,
      cwd: "/work/project",
      evidence: { kind: "classified", status: "blocked" },
      terminalTitle: `Agent ${index}`,
      terminalId: "",
      displayId: `pane-${index}`,
      pickerState,
    })),
    failures: [],
    complete: true,
    notices: [],
  };
  const blocks = agentPickerBlocks(result, ["orca"]) as unknown as Array<{
    accessory: {
      option_groups: Array<{
        options: Array<{ text: { text: string }; value: string }>;
      }>;
    };
  }>;
  const options = blocks[0]!.accessory.option_groups[0]!.options;
  assert.deepEqual(
    options.map((option) => option.text.text.split(" ")[0]),
    states.map(([, icon]) => icon),
  );
});

test("an incomplete empty agent list explains backend failures and notices", () => {
  const result: ListResult = {
    agents: [],
    failures: [{ backend: "herdr", reason: "CLI unavailable" }],
    complete: false,
    notices: [
      "Orca 上の Codex は未対応です",
      "orca:tab:leaf: セッションを特定できないため接続できません",
      "Some entries were filtered.",
    ],
  };
  const text = JSON.stringify(agentPickerBlocks(result, ["herdr", "orca"]));
  assert.match(text, /herdr/);
  assert.match(text, /現在 herdr \/ orca 上/, "enabled healthy backends belong in the empty-state message");
  assert.match(text, /CLI unavailable/);
  assert.match(text, /Orca 上の Codex は未対応です/);
  assert.match(text, /不完全/);
  assert.match(text, /セッションを特定できないため接続できません/);
  assert.match(text, /Some entries were filtered/);
});
