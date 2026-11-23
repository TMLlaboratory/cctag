import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { parseClaudeHcComposer, parseClaudeHerdrComposer } from "./composer.js";

const namedCapture: { cols: number; frame: string; inverseFrame: string } = JSON.parse(
  readFileSync(new URL("./__fixtures__/hc-named-composer.ansi.json", import.meta.url), "utf8"),
);
const namedRule = namedCapture.frame.split("\r\n").find((row) => row.includes(" test-name ─"))!;
const plainNamedRule = stripVTControlCharacters(namedRule);
const alternateCapture: { cols: number; rows: number; frame: string } = JSON.parse(
  readFileSync(new URL("./__fixtures__/hc-alternate-native-composer.ansi.json", import.meta.url), "utf8"),
);

for (const [backend, parse, width] of [
  ["hc", parseClaudeHcComposer, 200],
  ["herdr", parseClaudeHerdrComposer, 53],
] as const) {
  const captures: Record<"mode-default" | "mode-auto" | "slash-dropdown", string> = JSON.parse(
    readFileSync(new URL(`./__fixtures__/${backend}-composer.ansi.json`, import.meta.url), "utf8"),
  );

  test(`${backend} recognizes the captured default and auto Claude composers`, () => {
    assert.doesNotMatch(captures["mode-default"], /shift\+tab to cycle/iu);
    assert.match(captures["mode-auto"], /shift\+tab to cycle/iu);
    for (const mode of ["mode-default", "mode-auto"] as const) {
      const parsed = parse(captures[mode], width);
      assert.ok(parsed, mode);
      assert.equal(parsed.draft, "");
      assert.equal(parsed.caret, 0);
      assert.equal(parsed.idle, true);
    }
  });

  test(`${backend} recognizes a named upper rule and keeps the name in the frame`, () => {
    const rows = (backend === "hc" ? namedCapture.inverseFrame : captures["mode-auto"]).split("\r\n");
    const prompt = rows.findIndex((row) => row.startsWith("❯\u00a0"));
    assert.ok(prompt > 0);
    if (backend === "herdr") {
      rows[prompt - 1] = plainNamedRule.slice(-width);
    }
    const parseNamed = (paint: string) => parse(paint, width, rows.length);
    const paint = rows.join("\r\n");
    const parsed = parseNamed(paint);
    assert.ok(parsed?.idle);
    const renamed = parseNamed(paint.replace("test-name", "next-name"));
    assert.ok(renamed?.idle);
    assert.notEqual(parsed.frame, renamed.frame);
    assert.equal(parseNamed(paint.replace("test-name", "short")), null);
    assert.ok(parseNamed(paint.replace("test-name", "テスト名a"))?.idle);

    rows[prompt + 1] = rows[prompt - 1]!;
    assert.equal(parseNamed(rows.join("\r\n")), null);
  });

  test(`${backend} refuses the captured slash dropdown and a composer without focus or complete bounds`, () => {
    const paint = captures["mode-default"];
    assert.equal(parse(captures["slash-dropdown"], width), null);
    assert.equal(parse(paint.replace("\x1b[7m", ""), width), null);
    assert.equal(parse(paint.replace(/─+/u, "─"), width), null);
    assert.equal(parse(paint, width - 1), null);
  });

  test(`${backend} refuses a synthetic footerless composer with intact rules and caret`, () => {
    const paint = captures["mode-default"];
    const rows = paint.split("\r\n");
    const composer = rows.findIndex((row) => row.startsWith("❯\u00a0"));
    assert.ok(composer >= 0);
    const trailer = paint.indexOf("\x1b[>4;2m");
    const synthetic = rows.slice(0, composer + 2).join("\r\n") + "\r\n" +
      (trailer < 0 ? "" : paint.slice(trailer));
    assert.equal(parse(synthetic, width), null);
  });
}

test("hc still refuses the captured inline native caret", () => {
  assert.equal(parseClaudeHcComposer(namedCapture.frame, namedCapture.cols), null);
});

test("hc reads the native caret in the captured named alternate screen", () => {
  const { frame, cols, rows } = alternateCapture;
  const parsed = parseClaudeHcComposer(frame, cols, rows);
  assert.ok(parsed?.nativeCaret && parsed.idle);
  assert.equal(parsed.draft, "");
  assert.equal(parsed.caret, 0);
  assert.match(parsed.frame, / test-name ─/u);
  assert.match(frame, /Update available/u);
});

test("hc refuses incomplete or ambiguous alternate screen cursor evidence", () => {
  const { frame, cols, rows } = alternateCapture;
  assert.equal(parseClaudeHcComposer(frame, cols, rows + 1), null);
  for (const paint of [
    frame.replace("\x1b[?1049h\x1b[!p", "\x1b[?1049h\x1b[!p\x1b[?25l"),
    frame.replace("\x1b[65;3H", "\x1b[65;4H"),
    frame.replace("\x1b[65;3H", "\x1b[66;3H"),
    frame.replace("❯\u00a0", "❯\u00a0\x1b[4mselected"),
    frame.replace("❯\u00a0", "\x1b[2J❯\u00a0"),
    frame.replace("\x1b[?9001l", "\x1b[?25l"),
    frame.slice(0, -2),
  ]) {
    assert.notEqual(paint, frame);
    assert.equal(parseClaudeHcComposer(paint, cols, rows), null);
  }
});

test("hc reads the fullscreen stash marker only in its measured position", () => {
  const { frame, cols, rows } = alternateCapture;
  const lines = frame.split("\r\n");
  const prompt = lines.findIndex((row) => row.startsWith("❯\u00a0"));
  assert.ok(prompt > 1);
  const banner = " ".repeat(cols - 16) + "\x1b[0m\x1b[38;2;153;153;153m draft stashed\x1b[0m";
  lines[prompt - 2] = banner;
  assert.equal(parseClaudeHcComposer(lines.join("\r\n"), cols, rows)?.stashed, true);
  lines[prompt - 2] = banner.slice(1);
  assert.equal(parseClaudeHcComposer(lines.join("\r\n"), cols, rows), null);
});
