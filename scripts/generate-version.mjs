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

const outPath = join(repoRoot, "src", "version.ts");
writeFileSync(outPath, `export const VERSION = "${pkg.version}";\n`);
console.log(`[generate-version] wrote ${outPath} (VERSION = "${pkg.version}")`);
