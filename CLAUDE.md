# CLAUDE.md

Instructions for Claude Code working in this repository. Everything about *what
a good change looks like* is in [CONTRIBUTING.md](CONTRIBUTING.md) and applies
equally — this file only records the things a coding agent would otherwise get
wrong here, and the repository conventions that are not visible from the code.

## This repository is public

Do not put a Claude session link (`https://claude.ai/code/session_…`) in a
commit message, a pull request body, an issue, or a code comment. The default
Claude Code footer includes one; drop that line here.

The link resolves only for an account with access to the session, so it does not
expose the conversation. That is exactly the problem: on a public repository it
is a URL no reader can ever open, published permanently in the history, and it
makes the repository's own record depend on an access model outside this
project's control. It also publishes activity metadata for no one's benefit.

Keep `Co-Authored-By: Claude <model> <noreply@anthropic.com>`. Attribution is
honest, conventional, and depends on nothing external.

History written before this rule still contains such links. Leave it alone —
rewriting a public history breaks every clone and the release tags.

## Verify against the real thing

The TUI-facing parts of this codebase have been wrong more than once because a
fixture was written from an assumption about how a screen renders. When a change
depends on what a pane actually shows or what a keystroke actually does, capture
it from a live pane and turn the capture into the fixture. `CONTRIBUTING.md`'s
*What tests can't cover* lists the areas where this is mandatory rather than
advisable.

Sending an unintended keystroke into someone's terminal is the worst failure
this project has. When cctag cannot read a screen, the correct behavior is to
say so and let the human answer — never to guess.

## Documentation and releases

- The README is bilingual (English + Japanese); everything else is English. A
  test enforces the two READMEs' heading parity and that internal links resolve.
- Lab-internal and student-facing material does not belong here. This repository
  is the OSS artifact.
- Do not cut a release for a documentation-only change: record it under
  `[Unreleased]` in `CHANGELOG.md`, and it ships with the next real change.
- Four copies of the version have to agree — `package.json`, both READMEs'
  status lines, and the tag. See `CONTRIBUTING.md`'s *Releasing*.

## Deploying is not one step

A Spoke runs from `dist/`, so a merged commit changes nothing until it is built
and the Spoke restarted — and the Hub is a separate machine on its own release.
Leaving one side behind stays invisible until a feature needs both, which has
happened. When a change spans the Hub/Spoke protocol, say so in the pull
request, and make the older side report that it needs updating rather than fail
silently.

## Testing notes

- `src/hub/index.ts` runs `main()` at import. Never import from it in a test —
  it starts a real server and the test run hangs. Side-effect-free helpers go in
  their own module (`hub/frame.ts`, `hub-url.ts` are there for this reason).
- A test that adopts a pane starts a poll loop. Call `engine.abortAll()` in a
  `finally`, or a failing assertion leaves the process alive.
- While a prompt is up, the poll loop sleeps on a 5s floor, so a test observing
  a prompt being replaced has to wait longer than that.
