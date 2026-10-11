import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { cellWidth, stripSidePane } from "./side-pane.js";

const FIXTURE_DIRS = [
  new URL("../agents/claude/__fixtures__/", import.meta.url),
  new URL("../agents/omp/__fixtures__/", import.meta.url),
  new URL("./__fixtures__/orca/", import.meta.url),
];

function screenTexts(): { name: string; text: string }[] {
  return FIXTURE_DIRS.flatMap((dir) =>
    readdirSync(dir)
      .filter((name) => name.endsWith(".json") && !name.startsWith("side-pane-"))
      .flatMap((name) => {
        const json = JSON.parse(readFileSync(new URL(name, dir), "utf8"));
        const tail = (json.result?.terminal ?? json.terminal)?.tail;
        return Array.isArray(tail) ? [{ name, text: tail.join("\n") }] : [];
      }),
  );
}

test("screens captured without a side pane come through unchanged", () => {
  const screens = screenTexts();
  assert.ok(screens.length > 10, "the fixture sweep must find the captured screens");
  for (const { name, text } of screens) assert.equal(stripSidePane(text), text, name);
});

test("a table's column border is not taken for a pane divider", () => {
  const table = [
    `┌${"─".repeat(50)}┬──────────┐`,
    ...Array.from({ length: 12 }, (_, i) => `│ ${`row ${i}`.padEnd(48)} │ value    │`),
    `└${"─".repeat(50)}┴──────────┘`,
  ].join("\n");
  assert.equal(stripSidePane(table), table);
});

test("each pane run is cut at its own column, leaving rows outside it alone", () => {
  const pane = (col: number, rows: number) => Array.from({ length: rows }, () => `${" ".repeat(col)}│ pane`);
  const text = [...pane(50, 9), "full width row │ kept", ...pane(60, 9)].join("\n");
  const stripped = stripSidePane(text).split("\n");
  assert.equal(stripped[9], "full width row │ kept");
  assert.ok(stripped.every((row, i) => i === 9 || row === ""));
});

test("emoji the transcript uses count as two cells, like the CJK around them", () => {
  for (const cp of [0x2705, 0x274c, 0x2b50, 0x26a1, 0x2728, 0x1f680, 0x3042, 0xff21]) assert.equal(cellWidth(cp), 2, cp.toString(16));
  for (const cp of [0x2502, 0x276f, 0x23fa, 0x273b, 0x2610, 0x2714, 0x0041]) assert.equal(cellWidth(cp), 1, cp.toString(16));
});
