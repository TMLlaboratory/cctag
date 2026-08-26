# Contributing

## Getting the checks to run

```bash
npm install      # postinstall generates src/version.ts, which the build needs
npm run typecheck
npm test         # 178 tests, ~30s
npm run build
```

Those four are exactly what CI runs on every pull request, so a green local run
means a green CI run. There is no linter to satisfy.

Nothing here needs a Slack workspace or a running herdr: every test stubs
`HerdrClient`, and nothing in the suite constructs a real one. That is also the
limit of what the suite can tell you — see *What tests can't cover* below.

`npm test` passes a glob to `node --test`, which only expands it on **Node 21+**,
so the tests need a newer Node than the `>=20` cctag itself runs on. CI checks
that floor separately by building on Node 20 and importing the output.

## What to expect from a review

The bar here is not style, it's **whether the change is justified in a way the
next person can check**. Concretely:

- **Say why, not just what.** The commit log is the design record for this
  project — most messages are longer than their diffs, on purpose. A reader six
  months from now needs to know which alternative was rejected and what evidence
  decided it. If a fix is subtle, the message should make the *bug* legible, not
  just the patch.
- **Prefer measured over inferred.** Claims like "this is stale" or "this races"
  are worth much more with a count, a captured screen, or a reproduction. Several
  changes in this repo's history were wrong until someone measured; several
  survived review only because someone had.
- **State what you did not verify.** A change that names its own untested edge
  is easier to merge than one that implies it has none.
- **Tests that fail for the right reason.** For anything timing-dependent or
  environment-dependent, break it on purpose and confirm the test catches it. A
  flaky test is worse than no test: it makes the thing it guards look broken. One
  in this repo had to be rewritten for exactly that.

## What tests can't cover

Roughly half of what cctag does can only be verified against a live pane, and
reviewers cannot check it for you:

- **Anything read off the screen.** Permission and question dialogs are parsed
  from `herdr pane read`, because neither agent writes a pending prompt to its
  transcript until after it is answered. The rendering changes without notice —
  a multi-select question broke this way, because a checkbox appears on the
  free-text row and the fixture had been written from assumption rather than
  captured. **If you touch `src/agents/*/prompts.ts`, capture a real pane and add
  it as a fixture.**
- **Anything that depends on herdr's reported status.** herdr decides a pane's
  state from prioritized detection rules that ship in a remotely-updated
  manifest, so its answers can change with no herdr release. `herdr agent
  explain <pane> --json` shows which rule won, which is the fastest way to tell a
  cctag bug from a herdr one.
- **Anything about keystrokes actually landing.** Submitting text and its Enter
  used to be two calls and raced the TUI's paste handling; several fixes in this
  area are only meaningful against real hardware.

Sending an unintended keystroke into someone's terminal is the worst failure
this project has. When cctag cannot read a screen, the correct behavior is to
say so and let the human answer — never to guess.

## Releasing

Versioning is semver, currently `0.x` deliberately: the interface still moves.
See [CHANGELOG.md](CHANGELOG.md).

1. Add the release's entry to `CHANGELOG.md`, grouped by what a reader would
   look for rather than replayed commit by commit.
2. Bump `version` in `package.json`. Both READMEs' status lines name the version
   too, and a test fails if they disagree.
3. Tag it: `git tag -a vX.Y.Z -m "..."` and push the tag.

Pushing a `v*` tag builds three binaries for four platforms and publishes them
with `SHA256SUMS` to a GitHub Release. The version string is baked in at build
time from `package.json`, so `scripts/generate-version.mjs` **fails the release
if the tag and `package.json` disagree** — the failure is at dependency install,
before anything is built. Nothing is published from a mismatch.

## Documentation

The README is bilingual (English + Japanese); everything else is English. A test
enforces that the two READMEs keep the same heading structure, that no
`docs/*.ja.md` appears, and that internal links resolve — documentation drifts
silently, so it is checked rather than trusted.

Where things go:

- [README.md](README.md) — what cctag is, and how to run it
- [docs/how-it-works.md](docs/how-it-works.md) — the mechanism. No comparisons
  to other tools live here
- [docs/comparison.md](docs/comparison.md) — where cctag sits relative to other
  tools, including where they are the better choice. No mechanism lives here
