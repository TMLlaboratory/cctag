# Changelog

All notable changes to cctag are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0/).

**cctag is pre-1.0, and `0.x` is a deliberate claim rather than a placeholder:**
the interface still moves. A minor bump may change behavior that a `1.x` project
would have to keep. Pin an exact version if that matters to you.

## [Unreleased]

### Changed

- CONTRIBUTING.md no longer pins the test count, lists `npm ci` as CI runs it,
  and covers the Orca backend alongside herdr where it describes what the
  tests fake and where screens are read from.

## [0.6.1] - 2026-10-22

### Security

- follow-redirects, which `@slack/bolt` pulls in through axios, is updated to
  1.16.1 past two advisories where credential headers could survive a
  cross-origin redirect (GHSA-q3jh-wrc6-jgq8, GHSA-8r9p-f939-6h3c). Both
  `package-lock.json` and the `bun.lock` the release binaries are built from
  are updated. cctag's own code is unchanged.

## [0.6.0] - 2026-10-16

### Added

- Codex CLI on Orca is listed in `connect` when it runs its own app server
  (Orca's default, "Run each Codex terminal on its own server"). cctag ties the
  pane to the one rollout the Codex process holds open for writing, skipping
  its guardian reviewer's, rechecks that binding before every write, and reads
  its output and status from that rollout. A Codex on the shared background
  server writes no rollout of its own and is not listed, nor is one that has
  not had its first message yet (it creates its rollout then); `list` says what
  to do. If the person switches to another Codex thread mid-turn, the Slack
  turn ends with a notice rather than replaying that thread into Slack. Approval prompts are
  posted as "answer in the terminal" without buttons, and `model` is refused
  before `/model` is typed: Codex 0.162 confirms an approval on its digit alone,
  and Orca has no way to back out of the model menu.

### Changed

- Someone who has never been issued a token is now told so when they mention
  cctag, with a link to the Spoke setup steps. They used to get the notice for
  a stopped Spoke ("spokeデーモンが起動しているか確認してください"), which pointed a
  new user at a daemon they had never set up. Takes effect once the Hub runs it.

### Fixed

- A Claude Code permission prompt that carries the auto-deny countdown (the
  dangerous `rm` prompt in auto mode, since Claude Code 2.1.281) is now one
  prompt in Slack. The countdown redrew every second, so cctag took each redraw
  for a new prompt: it marked the last post answered at the terminal, posted the
  same prompt again every few seconds, and a button press stopped on a changed
  screen. This happened on herdr and Orca alike.
- The same holds when the pane is too narrow for the countdown and it wraps:
  the rows that finish its sentence are dropped with it. Before, the second row
  stayed in the prompt and came and went with terminal focus, so the prompt was
  re-posted each time focus moved.
- A Slack turn on Codex CLI on Orca no longer ends with "インスタンスが終了しました"
  when a poll lands while Codex's guardian reviewer has opened its rollout but
  not yet written the first line. That poll now counts as a failed query and is
  retried, instead of reading as a gone agent.

## [0.5.0] - 2026-10-12

### Added

- One Spoke can now use herdr and Orca at once: Claude Code works on either
  backend, Codex CLI on herdr, and `omp` on Orca. Orca's shared Codex app server
  can attribute status to the wrong pane, so its Codex panes are not listed.
  OMP questions and approvals show “answer in the terminal” with no Slack
  answer buttons; Slack answers to those prompts and `mode`/`plan`/`model`
  commands are unavailable.
  Orca writes revalidate the foreground process identity; `omp` writes also
  revalidate the transcript. Herdr target IDs and existing pairings keep their
  format. The Hub is unchanged.

### Changed

- The README and guides distinguish supported Herdr/Orca agent combinations,
  terminal-only OMP prompt handling, and Claude Code/Codex answers from Slack
  or the terminal.

### Fixed

- A turn on herdr is no longer closed by a moment of `idle` mid-turn. herdr's
  `idle`/`done` was believed at once even while the transcript said the turn
  was still running, so an adopted terminal turn was posted as
  "完了（テキスト応答なし）" nine seconds in, its transcript ending on a tool
  call. Against a running turn, that status now has to last 15 seconds; a turn
  that writes its end still settles at once (#47).
- A Claude Code question in a named session reaches Slack again on herdr.
  The dialog's bottom rule carries the session name, and herdr's rule for a
  blocked form looks only below the last rule, so herdr reported the pane
  `idle` with the question on screen and no buttons were posted. When herdr
  says `idle`/`done` while the transcript says the turn is still running,
  cctag now reads the screen itself and treats a prompt it finds there as
  blocked (#46).
- Both of those now also hold for a turn that was already running when the
  Spoke started. On herdr, the watcher's baseline did not record that the
  turn was running, so after a restart mid-turn one moment of `idle` posted
  the terminal's response half-finished, and a question in a named session
  was missed.
- On Orca, a free-text answer to a Claude Code question is submitted again.
  Typing replaced the "Type something." row the dialog was recognized by, so
  the check before Enter took the screen for a different prompt and stopped,
  leaving the text typed but unsent. An answer with a line break also failed
  the check, which read only its first line.
- An answer from Slack starts from where the dialog's cursor is. Buttons and
  free text assumed option 1, so after someone moved the cursor at the terminal
  a digit was typed into the free-text row and free text landed on "Chat about
  this". With text already in the free-text row, or a digit to send while the
  cursor is on it, cctag now says so and sends nothing.
- A question that wraps onto two rows is posted whole, not only its last row.
- A Claude Code question is read again while a mod draws a side pane beside
  the TUI (seen with qa-guide). The pane's text shared every row with the
  dialog, so on Orca the question was reported as unreadable, and on herdr it
  was offered as a y/n permission menu whose buttons would have typed into it.
  When a prompt still cannot be read, Slack now shows the bottom of the screen,
  where the prompt is, instead of the top.
- A thread reply that mentions @cctag now answers a Claude Code question or
  plan waiting for a typed answer. It used to be refused as busy, because the
  turn is still running while the prompt waits, so the "reply in this thread"
  the prompt offers only worked without the mention.
- On Orca, a Slack message is no longer refused because Claude Code shows a
  next-prompt suggestion in the composer: Orca reports the suggestion like typed
  text, so cctag now tells the two apart with one reversible character. A
  suggestion is replaced by the message; a typed draft is stashed with Ctrl+S,
  the message is sent, and Claude Code restores the draft (an earlier stash is
  overwritten). A new session's empty `Try "…"` composer is now accepted as
  empty, so sending to it is no longer refused. When cctag cannot confirm the
  composer's state it sends nothing and says what may be left there. Verified
  with Claude Code 2.1.287.

### Security

- Dependencies pulled in by `@slack/bolt` are updated past published
  advisories: axios 1.20.0, proxy-addr 2.0.8 and qs 6.16.0, in both
  `package-lock.json` and the `bun.lock` the release binaries are built from.
  cctag's own code is unchanged.

## [0.4.0] - 2026-10-11

### Fixed

- The Hub now notices a Spoke that went silent. The Spoke already pinged the
  Hub and reconnected when its pongs stopped, but nothing watched the other
  direction: a Spoke that vanished without closing its connection (sleep, a
  network change) stayed registered, and every Slack message for its owner was
  dispatched into it and lost without a word until the OS gave up on the TCP
  connection. The Hub pings each Spoke every 30 seconds and drops one that has
  not answered for 90. A dispatch that fails now gets a reply in the thread:
  that the Spoke could not be reached when its connection closed, or that it
  has not answered when the call timed out — which can also be a mention whose
  attachment is still downloading, so that reply does not say the message was
  lost. An exception on the Spoke gets no reply, since the Spoke got the message
  and is alive. Ordinary messages, which arrive as a stream, get at most one
  reply a minute per thread. Takes effect when the Hub is
  redeployed; Spokes need no change, and the released Bun-compiled Spoke was
  measured answering the Hub's pings.
- Long replies no longer lose their tables. Prose was cut into pieces of up
  to 3,900 characters, but a Block Kit section holds 3,000, so a reply with a
  3,000–3,900-character run of prose was rejected as `invalid_blocks` and
  re-posted as plain text, its tables turned into monospace grids. Long
  bilingual replies hit this most. Prose bound for blocks is now cut at the
  section limit.
- The Hub no longer keeps the location of every message it has ever posted.
  `messageLocations`, which lets a Spoke edit a message it posted earlier, got
  an entry per post and lost none, so it grew for the life of the process. It
  is now capped at the 5,000 most recent, as `fileOwner` already was at 500;
  edits happen within a turn or when a prompt is answered, and an edit to an
  evicted message is skipped as an unknown one already was. Takes effect when
  the Hub is redeployed.
- Interrupting Claude Code now ends the turn. The transcript records an
  interrupt as a user message beginning `[Request interrupted by user`, which
  was read as a new turn starting: the transcript never said the interrupted
  turn had ended. It is now an `aborted` boundary, as Codex's `turn_aborted`
  already was.
- A Claude Code local command (such as `/compact`, `/model`, `/effort` or
  `/copy`) now ends its turn when it prints its output. These commands write no
  assistant reply, so the transcript read as a turn that started and never
  ended. herdr's own idle status hid this; a backend that takes the turn's end
  from the transcript waited until the turn timed out.
- Bold in an agent's reply now renders as bold in Slack. The italic rule ran
  after the bold one and rewrote its `*x*` as `_x_`, so every `**x**` since the
  first release came out italic — and next to Japanese text, where Slack needs a
  boundary outside the markers, as literal underscores. A zero-width space now
  goes outside a bold or italic marker wherever there is no whitespace or line
  edge, which is what makes `これは*太字*です` and `「*太字*」` render (checked
  in a live thread). Inline code is also left alone now: `` `**x**` `` used to
  come out as `*x*`, and a lone `` `*` `` could pair with a later one and break
  the span.
- A question or permission button now answers only the prompt it was posted for,
  and only from the thread the pane is paired to. Prompt IDs restarted at 1 on
  every turn, so a button left over from an earlier turn could match a newer
  prompt with the same number and send its keystroke there. IDs are now random
  and never reused within a Spoke process, and the pressing thread's pairing
  must be the one the turn belongs to. The button value keeps its shape, so the
  Hub is unchanged.
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
- A thread whose agent is not known gets its own help text. The Claude variant
  had been doing double duty as the fallback, which is why the same defect was
  reported twice: first the `connect` line told an unpaired reader to connect "a
  Claude Code instance", and after that line was made agent-agnostic, `model`
  still described switching *Claude Code's* model and `mode` / `plan` were listed
  without saying they are Claude-only. One text cannot serve both cases — every
  agent-specific line is either wrong for the unpaired reader or missing for the
  paired one. The lines the three variants share are now written once.
- The ownership note is separated from the bullet above it by a blank line. It is
  the only line without a `•`, under a bullet long enough to wrap, so it read as
  another wrapped fragment of that bullet — and a note that exists to correct a
  misreading has to be legible on its own.
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

[Unreleased]: https://github.com/TMLlaboratory/cctag/compare/v0.6.1...HEAD
[0.6.1]: https://github.com/TMLlaboratory/cctag/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/TMLlaboratory/cctag/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/TMLlaboratory/cctag/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/TMLlaboratory/cctag/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/TMLlaboratory/cctag/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/TMLlaboratory/cctag/releases/tag/v0.2.0
