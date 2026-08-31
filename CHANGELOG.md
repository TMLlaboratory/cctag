# Changelog

All notable changes to cctag are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0/).

**cctag is pre-1.0, and `0.x` is a deliberate claim rather than a placeholder:**
the interface still moves. A minor bump may change behavior that a `1.x` project
would have to keep. Pin an exact version if that matters to you.

## [Unreleased]

### Fixed

- The Hub's file cap now bounds what it will read, not just what it will accept.
  `CCTAG_MAX_FILE_MB` was compared only after a frame had been received and
  parsed, so an oversized upload was rejected having already cost the memory —
  and `ws` defaults its own frame ceiling to 100 MiB. Measured on the Hub this
  was written for: 954 MB of RAM, no swap, two Hub processes, and no systemd
  memory limit, where one 100 MB frame becomes the frame, the parsed base64
  string and the decoded buffer at once. `maxPayload` is now derived from the
  file cap, and `ws` compares it against the length declared in the frame header
  before reading the payload. A well-behaved Spoke never reaches it — it clamps
  to the cap reported at registration — so this is the floor under one that is
  old, or not ours. The inbound direction was already right: `downloadSlackFile`
  applies the cap while streaming.
- `assets/cctag-hub.service` sets `MemoryMax`, so a spike kills the Hub at fault
  rather than leaving the choice of victim to the OOM killer — on a box where the
  other victim could be the other workspace's Hub, or sshd.

- The help no longer names one agent as the thing to connect. An unpaired thread
  has no driver, so `helpTextFor` falls back to the Claude variant — and that
  variant said to connect "a Claude Code instance", in exactly the state where
  nobody has picked an agent yet. `connect` offers every running pane, Codex
  included, and the help now says so.
- The help says what "owner only" means. "（オーナーのみ）" is accurate as access
  control and was read as *the channel's* owner. The authority is not a narrowed
  Slack permission: the Spoke runs on that person's own machine, so `connect` is
  them choosing among their own panes. `docs/how-it-works.md` already said this;
  the strings a reader actually sees did not. The refusal replies and the
  "not connected" reply carried the same word and are reworded too — the latter
  was written out at five call sites, which is why a wording fix had missed it,
  and is now one constant.

## [0.3.0] - 2026-08-31

### Fixed

- Terminal-side work no longer re-sends every file it has already sent. The
  watcher keeps one write tracker per watched pane and uploads on every settle
  it notices, and nothing cleared the confirmed set — so each settle handed over
  everything confirmed since the watch began. Measured in a thread where it
  happened: the oldest file posted 13 times, the next 6, the next 4, oldest most
  often. The text collected for a settle was emptied and the outbox baseline
  advanced right beside it; only the writes were not.
- A multi-select `AskUserQuestion` can now be answered from Slack. It never
  could: the message carried a numbered list and an invitation to reply in free
  text, and no interactive element at all. Reported from a four-question dialog
  where question 1 was answered by button and question 2 — the multi-select one
  — was not, so the whole dialog was finished at the keyboard instead. Slack has
  had a `checkboxes` element the whole time; the gap was cctag's. The submitting
  keystrokes were measured against a live dialog rather than inferred: a digit
  *toggles* a box and does not submit, the `Submit` row sits one past the
  free-text row, and the Enter there opens a review screen that needs its own
  confirmation. Answering a multi-select from Slack requires the Hub to be
  updated too; an older one is told to, rather than silently sending nothing.
- Replying to a multi-select question with free text no longer un-does itself.
  Typing into the dialog's free-text row ticks it automatically, and the Enter
  the single-select path sends means "select" there — so it unticked the answer
  and submitted nothing, leaving the dialog on screen. Reported as "replying
  1,3 didn't work".
- A reply of nothing but option numbers ("1,3") now ticks those boxes. Claude
  Code never read it that way: the free-text row records what was typed
  verbatim, so the agent received the string and had to guess. Only for
  multi-select, and only when every token is a valid option number.
- A prompt answered at the terminal keeps its question in the thread. The
  message was replaced by the bare note "answered at the terminal", so a thread
  showed that *something* had been asked and answered with no way to see what.

### Changed

- The README is split by who is reading it (667 lines to 236): joining a Hub,
  hosting one, and using a paired thread are now `docs/spoke-setup.md`,
  `docs/running-a-hub.md` and `docs/usage.md`. Detailed setup instructions are
  English only; the README stays bilingual.
- The mechanism walkthrough (`docs/how-it-works.md`) describes what cctag
  actually does now — pairings are addressed by `pane_id`, text is submitted in
  one call with `agent prompt`, and a turn ending is decided from the
  transcript. It also no longer calls `connect` a Claude-Code-only, permission-
  gated operation: it reaches Codex too, and being owner-only follows from the
  Spoke running on the owner's own machine rather than from an access rule.

### Added

- `docs/comparison.md` — where cctag sits relative to Claude Tag, Slack Code and
  Buzz, including where those are the better choice. Leads with the part that
  makes the rest credible: the artifact is not novel.
- `CONTRIBUTING.md` — how to run the checks, what a review looks for, the parts
  that can only be verified against a live pane, and the release process.
- Tests for the documentation invariants that nothing else noticed: the two
  READMEs keep the same heading structure, every internal link resolves, and the
  version the READMEs claim matches `package.json`.
- `src/slack/blocks.test.ts`, which did not exist: the block builders had no
  tests, which is how a branch that produced no buttons went unnoticed.

## [0.2.0] - 2026-08-25

The first tagged release. Everything below was developed between 2026-07-09 and
2026-08-25 without version tags — recoverable only as commit hashes, which is
what this file and the tags alongside it exist to fix. The README described this
period as "v0.1"; that label was never released and 0.2.0 is where versioning
actually starts.

### Requirements

- **herdr 0.7.5 or newer is required.** 0.7.5 stopped accepting `terminal_id`
  as an agent target, so cctag addresses panes by `pane_id` throughout. Pairings
  written before that change cannot be resolved; they are dropped on load with
  an explanation in the thread, and `@cctag connect` re-creates them.
- Verified against herdr 0.8.2. Its agent-state detection ships in a remotely
  updated manifest, so rendering and status behavior can change without a herdr
  release — see the settlement note under *Changed*.

### Added

- **Hub–Spoke mode**, so more than one person can share a single Slack app.
  Slack's Socket Mode delivers each event to exactly one connection, so separate
  full daemons would steal each other's events. The Hub holds the one connection
  and routes; each Spoke drives its owner's own machine and is the only side
  that touches a coding-agent session. Includes per-instance token namespacing,
  owner-bound token issuance, and support for several Spokes (one per Slack
  workspace) on one machine via `CCTAG_ENV_FILE`.
- **Codex CLI support**, through a per-pane `AgentDriver` abstraction selected
  from herdr's live-reported agent kind. One `@cctag` bot can be paired to either
  Claude Code or Codex sessions; unsupported features reply saying so rather than
  failing quietly.
- **Files and images in both directions.** Slack attachments are delivered to the
  agent (real image attachments for Claude Code, an `exec` read for Codex), and
  the agent sends files back via `SendUserFile` or the `.cctag/outbox` directory.
- **Prompts as Slack buttons.** Tool-permission and command-approval menus, and
  Claude Code's `AskUserQuestion` dialogs, are posted with buttons; free-text
  answers are supported where the dialog offers them. Answering at the keyboard
  instead updates the Slack message to say so.
- **Plan Mode over Slack** — the plan is attached as a `.md` file, approval is a
  button, and a plain thread reply is routed to "Tell Claude what to change", so
  a plan can be refined from Slack before any code runs.
- **`@cctag model` and `@cctag mode`** for switching model and the Shift+Tab mode
  ring (`manual` / `accept-edits` / `plan` / `auto`).
- **Background watcher**, so work started at the terminal — before pairing, or
  between Slack turns — still reaches the thread. A prompt hit outside Slack is
  handed to the same turn engine, so it gets buttons like any other.
- **`@cctag log`**, which feeds thread messages that were never addressed to
  cctag into the paired agent.
- **Attribution for multi-person threads**: messages and button presses from
  someone other than the owner carry the sender's display name, and mentions are
  resolved to names rather than dropped.
- **Markdown tables** are rendered as Block Kit tables, with a plain-text
  fallback when Slack rejects a block post.

### Changed

- **Turn completion is decided from the agent's own transcript, not from herdr's
  `agent_status`.** A lingering background shell makes herdr report `working`
  indefinitely — a detection rule outranking every idle signal — so both the
  poll loop and the watcher waited forever: turns burned their full timeout and
  reported one, and terminal-side output was collected but never posted. Claude
  Code's `turn_duration` record and Codex's `task_complete` event are the
  boundaries now, and `blocked` is never second-guessed, so prompt handling is
  unchanged.
- **The turn timeout measures silence, not elapsed time.** Transcript progress
  refreshes the deadline, so a long turn that is producing output is no longer
  cut off at `CCTAG_TURN_TIMEOUT_MS`.
- **Prompts are submitted atomically** via herdr's `agent prompt`, replacing
  send-text-then-Enter, which raced Claude Code's paste handling and left
  messages unsent. A verify-and-retry guard covers the case where the submit is
  silently dropped.
- **One exclusive pane lease** replaced three separate busy-markers as the way
  concurrent turns are kept off the same pane.
- **The connect picker** groups by project directory and reads session titles
  from herdr.
- Per-file attachment cap raised from 8MB to 10MB.

### Fixed

- A pairing whose pane outlives its agent is no longer kept forever. Quitting the
  CLI to restart it in the same pane is still survivable, but after five minutes
  the pairing is dropped and the thread is told — previously only *closing the
  terminal* ever triggered that.
- A multi-select `AskUserQuestion` is read correctly. Such dialogs put a checkbox
  on every row including the free-text one (`5. [ ] Type something`), which
  defeated the anchor the parser finds the dialog by, so the question was posted
  as an unparseable menu.
- A prompt cctag cannot read is no longer answered blind. It used to offer
  yes/no buttons that sent a bare `y`, which in a checkbox list can toggle or
  submit a choice nobody made; an unreadable *question* now asks for a keyboard
  answer instead. The screen is also logged, so a failure stays diagnosable after
  the Slack message is gone.
- A denied `Write` no longer uploads the file it was denied on, and outbox files
  are no longer delivered to the wrong thread when two panes share a directory.
- `@cctag log <instruction>` no longer discards the instruction when the scanned
  history is empty.
- Corrupted or incomplete pairing entries are dropped at load instead of hanging
  the thread that owns them.
- Attachment downloads enforce their size cap while streaming rather than after
  buffering, and a Spoke clamps to the Hub's cap before transferring rather than
  discovering the limit afterwards.
- Spoke reconnect storms, and a turn that outlived its own loop finalizing a
  different turn on the same pane.
- Startup dialogs — the directory-trust prompt, and Codex's update prompt, which
  defaults to running `brew upgrade` — are detected before a turn is started on
  a pane sitting at one.
- A permission prompt's quoted context no longer reaches past the rule that
  bounds it, which used to paste unrelated output into the Slack code block.

[Unreleased]: https://github.com/TMLlaboratory/cctag/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/TMLlaboratory/cctag/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/TMLlaboratory/cctag/releases/tag/v0.2.0
