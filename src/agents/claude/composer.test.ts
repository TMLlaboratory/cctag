import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseClaudeHcComposer, parseClaudeHerdrComposer } from "./composer.js";

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
