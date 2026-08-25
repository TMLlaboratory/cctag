// Writes src/version.ts from package.json's version. Run as `node
// scripts/generate-version.mjs` (also wired as the `postinstall` script, so
// it runs automatically right after `bun install`/`npm install`).
//
// src/version.ts is gitignored, not tracked — it's regenerated every time,
// not hand-maintained. This exists because a `bun build --compile` binary is
// a single standalone executable: once deployed to a machine that doesn't
// have this repo checked out, it cannot read package.json (or anything else
// outside its own bundle) at runtime. Any version string it prints has to be
// baked into the bundle at build time, which means it has to come from a
// source file that gets compiled in, not a JSON read at startup.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

// When a tag is what triggered this build, the tag and package.json have to
// agree, because they are two independent claims about the same thing and only
// one of them is visible to whoever downloads the binary. The release workflow
// fires on any `v*` tag but bakes in package.json's version, so forgetting the
// bump publishes assets named v1.2.0 whose `--version` answers 0.1.0 — wrong in
// the direction nobody checks, since the download link looks right.
//
// Enforced here rather than in the workflow on purpose: this script already
// runs there via postinstall, so the check costs no extra step, and it stays
// with the thing it is checking. GITHUB_REF_NAME is also set for branch pushes
// (`main`), hence the tag-shaped guard rather than a bare presence test —
// outside a tagged build this does nothing at all.
const ref = process.env.GITHUB_REF_NAME;
if (ref && /^v\d/.test(ref)) {
  const tagged = ref.slice(1);
  if (tagged !== pkg.version) {
    console.error(
      `[generate-version] tag ${ref} does not match package.json version ${pkg.version}.\n` +
        `Bump "version" in package.json to ${tagged} (and say so in CHANGELOG.md), then re-tag.`,
    );
    process.exit(1);
  }
  console.log(`[generate-version] tag ${ref} matches package.json`);
}

const outPath = join(repoRoot, "src", "version.ts");
writeFileSync(outPath, `export const VERSION = "${pkg.version}";\n`);
console.log(`[generate-version] wrote ${outPath} (VERSION = "${pkg.version}")`);
