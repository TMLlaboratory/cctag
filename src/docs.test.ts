import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

// Invariants about the documentation, checked by the same `npm test` everything
// else runs under. Documentation drifts silently — nothing fails when it does,
// which is exactly why it needs a test rather than a convention.

const DOCS = ["README.md", "README.ja.md", "docs/how-it-works.md", "docs/how-it-works.en.md", "CHANGELOG.md"];

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

/** Heading levels in document order — the shape of a document, without its language. */
function headingShape(markdown: string): string[] {
  return markdown
    .split("\n")
    .filter((line) => /^#{2,} /.test(line))
    .map((line) => line.match(/^#+/)![0]);
}

test("the two READMEs stay structurally parallel", () => {
  // They already differ by ~90 lines, which is fine — Japanese is simply more
  // compact per section. What must not differ is the *structure*: a section
  // added to one language and not the other is how a translation stops being
  // one, and the drift is invisible until someone reads both side by side.
  //
  // Compares heading levels rather than text, since the text is supposed to
  // differ. Section *order* is covered too, by comparing the sequences.
  const en = headingShape(read("README.md"));
  const ja = headingShape(read("README.ja.md"));
  assert.deepEqual(
    ja,
    en,
    `README.md has ${en.length} headings and README.ja.md has ${ja.length}, or their nesting diverges — ` +
      "add the section to both, or move it out of the READMEs entirely",
  );
});

test("every internal documentation link resolves", () => {
  // A moved or renamed file leaves the link behind, and the only thing that
  // notices is a reader who follows it. Relative to each document's own
  // directory, since docs/ links up and out.
  const broken: string[] = [];
  for (const doc of DOCS) {
    const dir = dirname(doc);
    for (const match of read(doc).matchAll(/\]\(([^)#\s]+)/g)) {
      const target = match[1];
      if (/^(https?:|mailto:)/.test(target)) continue;
      const resolved = normalize(join(dir, target));
      if (!existsSync(new URL(`../${resolved}`, import.meta.url))) broken.push(`${doc} -> ${target}`);
    }
  }
  assert.deepEqual(broken, [], `broken internal links:\n  ${broken.join("\n  ")}`);
});

test("the version the README claims matches package.json", () => {
  // Two independent claims about the same thing, and the README is the one a
  // reader sees first. The release build already refuses to publish a tag that
  // disagrees with package.json (scripts/generate-version.mjs); this covers the
  // third copy, which nothing else was checking.
  const version = (JSON.parse(read("package.json")) as { version: string }).version;
  for (const doc of ["README.md", "README.ja.md"]) {
    assert.ok(
      read(doc).includes(`v${version}`),
      `${doc} does not mention v${version} — update its status line when bumping the version`,
    );
  }
});
