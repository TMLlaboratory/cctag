import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import type { ScreenSnapshot } from "../../backend/types.js";
import { driverFor } from "../driver.js";
import { OMP_RESUME_NOTICE, ompDriver } from "./driver.js";
import {
  classifyOmpScreen,
  formatOmpScreenNotice,
  isOmpIdleComposer,
  ompScreenBody,
  ompScreenFingerprint,
  OMP_WAITING_NOTICE,
  type OmpScreenClass,
} from "./prompts.js";

function fixtureTerminal(filename: string): Record<string, unknown> {
  const capture = JSON.parse(readFileSync(new URL(`./__fixtures__/${filename}`, import.meta.url), "utf8")) as {
    terminal: Record<string, unknown>;
  };
  return capture.terminal;
}

function screenFromTerminal(terminal: Record<string, unknown>): ScreenSnapshot {
  const tail = terminal.tail;
  const validTail = Array.isArray(tail) && tail.every((row) => typeof row === "string");
  const rows = Array.isArray(tail) ? tail.filter((row): row is string => typeof row === "string") : [];
  return {
    text: rows.join("\n"),
    draft: typeof terminal.draft === "string" ? terminal.draft : null,
    complete:
      validTail &&
      terminal.source === "screen" &&
      terminal.status === "running" &&
      terminal.limited === false &&
      terminal.truncated === false,
  };
}

function capturedScreen(filename: string): ScreenSnapshot {
  return screenFromTerminal(fixtureTerminal(filename));
}

const STARTUP_HINT = "⇧⇥ to change thinking effort";
const STARTUP_HINT_SCREENS = [
  "idle-startup.screen.json",
  "approval-startup.screen.json",
  "session-dir-startup.screen.json",
] as const;

function withComposerFooterInput(snapshot: ScreenSnapshot, input: string): ScreenSnapshot {
  const rows = snapshot.text.split("\n");
  const footerIndex = rows.length - 1;
  const inputWidth = (rows[footerIndex]?.length ?? 4) - 4;
  rows[footerIndex] = `╰─${input.padEnd(inputWidth, " ")}─╯`;
  return { ...snapshot, text: rows.join("\n") };
}

test("OMP is discoverable but cannot answer prompts or change modes", async () => {
  assert.equal(driverFor("omp"), ompDriver);
  assert.equal(ompDriver.orcaProcess?.listable, true);
  assert.equal(ompDriver.orcaProcess?.sessionUnavailableNotice, OMP_RESUME_NOTICE);
  assert.equal(ompDriver.orcaProcess?.matchesCommand("/usr/local/bin/omp --profile team"), true);
  assert.equal(ompDriver.orcaProcess?.matchesCommand("/opt/homebrew/bin/node /opt/omp"), false);
  assert.equal(ompDriver.modes, null);
  assert.deepEqual(ompDriver.parseBlockedPane("unreadable OMP prompt"), { kind: "unreadable-question" });

  let writes = 0;
  const answerChannel = {
    digit: async () => { writes++; },
    confirm: async () => { writes++; },
  } as unknown as Parameters<typeof ompDriver.answerOption>[0];
  await assert.rejects(ompDriver.answerOption(answerChannel, "1", "Approve"), /answered in the terminal/u);
  assert.equal(writes, 0);
});

test("OMP classifies the staged complete V7 screens by their bottom UI", () => {
  const cases: Array<[string, OmpScreenClass]> = [
    ["idle.screen.json", "idle"],
    ["working.screen.json", "working"],
    ["draft.screen.json", "waiting"],
    ["ask-open.screen.json", "waiting"],
    ["ask-open-second.screen.json", "waiting"],
    ["ask-closed.screen.json", "idle"],
    ["settings-open.screen.json", "waiting"],
    ["settings-closed.screen.json", "idle"],
    ["approval.screen.json", "waiting"],
    ["resumed-session.screen.json", "idle"],
    ["child-omp.screen.json", "idle"],
  ];

  for (const [filename, expected] of cases) {
    assert.equal(classifyOmpScreen(capturedScreen(filename)), expected, filename);
  }
});

test("OMP startup footer hints do not turn empty composers into drafts", () => {
  for (const filename of STARTUP_HINT_SCREENS) {
    const startup = capturedScreen(filename);
    assert.equal(startup.complete, true, filename);
    assert.equal(classifyOmpScreen(startup), "idle", filename);
    assert.equal(ompDriver.isIdleComposer?.(startup), true, filename);

    const inputWidth = startup.text.split("\n").at(-1)!.length - 4;
    const draftPrefix = "draft text";
    const draftWithHint =
      `${draftPrefix}${" ".repeat(inputWidth - draftPrefix.length - STARTUP_HINT.length - 1)}` +
      `${STARTUP_HINT} `;
    const typedHintAtLeft = STARTUP_HINT.padEnd(inputWidth, " ");
    for (const [name, input] of [
      ["other text alongside the right-aligned hint", draftWithHint],
      ["the hint typed at the left of the input row", typedHintAtLeft],
    ] as const) {
      const draft = withComposerFooterInput(startup, input);
      assert.equal(classifyOmpScreen(draft), "waiting", `${filename}: ${name}`);
      assert.equal(ompDriver.isIdleComposer?.(draft), false, `${filename}: ${name}`);
    }
  }
});

test("OMP notices do not change idle classification, and an open frame above composer blocks idle", () => {
  const idle = capturedScreen("idle.screen.json");
  const rows = idle.text.split("\n");
  const tipIndex = rows.findIndex((row) => row.includes("Tip:"));
  const updateIndex = rows.findIndex((row) => row.includes("New version"));
  assert.notEqual(tipIndex, -1);
  assert.notEqual(updateIndex, -1);
  rows[tipIndex] = " Tip: a different notice";
  rows[updateIndex] = " New version 99.99.9 is available. Run: omp update";
  const changedNotices = { ...idle, text: rows.join("\n") };
  assert.equal(classifyOmpScreen(changedNotices), "idle");
  assert.equal(isOmpIdleComposer(changedNotices), true);

  const withOpenFrame = idle.text.split("\n");
  withOpenFrame.splice(withOpenFrame.length - 2, 0, "╭─ Ask ─", "│ pending question");
  const modalAboveComposer = { ...idle, text: withOpenFrame.join("\n") };
  assert.equal(classifyOmpScreen(modalAboveComposer), "waiting");
  assert.equal(isOmpIdleComposer(modalAboveComposer), false);
});

test("OMP recognizes both active status row shapes and rejects a draft composer", () => {
  const idle = capturedScreen("idle.screen.json");
  assert.equal(classifyOmpScreen({ ...idle, text: `⎋ Working…\n${idle.text}` }), "working");
  assert.equal(isOmpIdleComposer(idle), true);

  const draft = capturedScreen("draft.screen.json");
  assert.equal(classifyOmpScreen(draft), "waiting");
  assert.equal(isOmpIdleComposer({ ...draft, draft: null }), false);
  assert.equal(isOmpIdleComposer({ ...idle, draft: "unseen draft" }), false);
});

test("OMP leaves incomplete, partial, empty, and failed reads unclassified", () => {
  const terminal = fixtureTerminal("idle.screen.json");
  const invalidMetadata: Array<[string, Record<string, unknown>]> = [
    ["truncated", { truncated: true }],
    ["limited", { limited: true }],
    ["non-screen", { source: "history" }],
    ["not-running", { status: "exited" }],
    ["invalid tail", { tail: ["complete row", 7] }],
  ];

  for (const [name, changes] of invalidMetadata) {
    const snapshot = screenFromTerminal({ ...terminal, ...changes });
    assert.equal(snapshot.complete, false, name);
    assert.equal(classifyOmpScreen(snapshot), null, name);
    assert.equal(isOmpIdleComposer(snapshot), false, name);
  }

  for (const snapshot of [
    { text: "", draft: null, complete: false },
    { text: "╭── π > partial", draft: null, complete: false },
    { text: "read failure", draft: null, complete: false },
  ]) {
    assert.equal(classifyOmpScreen(snapshot), null);
    assert.equal(isOmpIdleComposer(snapshot), false);
  }
  assert.equal(classifyOmpScreen({ text: "$ ", draft: null, complete: true }), "waiting");
});

test("OMP fingerprints stable waiting captures and removes the bottom composer frame", () => {
  const first = capturedScreen("ask-open.screen.json");
  const second = capturedScreen("ask-open-second.screen.json");
  assert.equal(first.complete, true);
  assert.equal(second.complete, true);
  assert.equal(ompScreenFingerprint(first), ompScreenFingerprint(second));

  const changedBody = { ...first, text: first.text.replace("<choice-A>", "<choice-X>") };
  assert.notEqual(ompScreenFingerprint(first), ompScreenFingerprint(changedBody));
  assert.equal(ompScreenFingerprint({ ...first, complete: false }), null);

  const idle = capturedScreen("idle.screen.json");
  const changedComposer = idle.text.split("\n");
  changedComposer[changedComposer.length - 2] = "╭── π > ◉ changed model and usage";
  changedComposer[changedComposer.length - 1] = "╰─ unsent draft ─╯";
  assert.equal(ompScreenFingerprint(idle), ompScreenFingerprint({ ...idle, text: changedComposer.join("\n") }));
});
test("OMP notices contain the captured body, omit both composer rows, and append the terminal instruction", () => {
  const waiting = capturedScreen("draft.screen.json");
  const rows = waiting.text.split("\n");
  const body = ompScreenBody(waiting);
  const notice = formatOmpScreenNotice(waiting);
  assert.ok(body);
  assert.ok(notice);
  assert.match(rows.at(-2) ?? "", /^╭──/u);
  assert.match(rows.at(-1) ?? "", /^╰─/u);
  assert.equal(body, rows.slice(0, -2).join("\n"));
  assert.equal(notice, `${body}\n\n${OMP_WAITING_NOTICE}`);
  assert.equal(formatOmpScreenNotice({ ...waiting, complete: false }), null);
});
