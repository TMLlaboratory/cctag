This document explains how cctag works internally (for setup steps, see the [README](../README.md)).

# How cctag works

## 1. What this tool does

**cctag bridges a Slack thread to a coding-agent terminal session running on
your own machine.**

The Herdr backend supports Claude Code and Codex CLI. Orca supports Claude Code
with the same cctag features as Herdr, plus `omp` text turns, output, status,
and `.cctag/outbox` uploads. Incoming attachments are passed as local paths;
Claude Code converts image paths into native image attachments. OMP questions
and approvals are reported to Slack but must be answered in the terminal.
Both backends keep the agent and local files on your machine; nothing is copied
to a sandbox.

How that compares to tools that start a fresh session instead — and where
those are the better choice — is [comparison.md](comparison.md). This document
only explains the mechanism.

This walkthrough uses Claude Code throughout, because the details that are
worth explaining — transcript layout, how a pending question is detected,
Plan Mode — are its own. Herdr supports Claude Code and Codex CLI through
per-pane drivers; Orca supports the same cctag feature set for Claude Code,
plus `omp` text turns, output, status, and `.cctag/outbox` uploads. Incoming
files are passed as paths, and only Claude Code turns image paths into native
image attachments. Codex on Orca is not listed; OMP questions and approvals
must be answered in the terminal. See the agent support table in the
[README](../README.md) for what differs.

```
Slack thread (@cctag)
        ↕
   cctag (Hub / Spoke)
        ↕
   Herdr or Orca (local)
        ↕
   Claude Code (on your PC)
```

## 2. Overall shape: Hub and Spoke

So that multiple people can share a single `@cctag`, cctag splits into two
roles.

| | Role | Runs on | Can do |
|---|---|---|---|
| **Hub** | The one connection to Slack | A small always-on server (e.g. a small cloud VM) | Receives Slack messages and forwards them to the right person's Spoke. **Never touches Claude Code or the local terminal backends** |
| **Spoke** | The local terminal connection | **Your own PC** | Lists, reads, and sends input to supported agents through enabled backends: Claude Code on either; Codex CLI on Herdr; `omp` on Orca |

The important part: **the Hub has no way to reach your terminal.** Even if
the Hub's server were compromised, it has no ability to control the Claude
Code running on your machine — only the Spoke running on your own PC can
actually do that. So anyone who wants to control their own PC's Claude Code
from Slack needs to have **their own Spoke running on their own PC**.

## 3. How this relates to herdr: why only "running agents" show up

cctag's Herdr backend talks to
[herdr](https://herdr.dev), whose agent registry narrows the available
panes. Orca is a separate backend with process-based discovery and write
identity checks, described below.

### herdr itself can write to any pane

herdr is fundamentally a tmux-like terminal multiplexer. Commands like
`pane read` (read the screen) and `pane send-keys` (send keystrokes) work
on **any pane herdr manages**, whether Claude Code is running in it or it's
just a plain shell. The in-house bridge that used raw tmux before herdr
(cc-slack-bridge v4) used exactly this raw power — it could send anything
to a hardcoded pane number, for better or worse.

### Herdr's agent list is one source for the picker

Herdr's `agent list` contributes supported, registered agents to cctag's
`@cctag connect` picker; it does not represent every terminal backend. What
appears there depends on Herdr's supported agent integrations, not on every
managed pane. Start Claude Code or Codex CLI with `herdr agent start` and
install its matching `herdr integration`; the integration supplies
agent-specific session reporting. Claude Code's `SessionStart` hook reports
its session ID. Codex CLI can appear in the list without one; trusting its
`herdr-agent-state.sh` `SessionStart` hook adds full session-ID reporting, and
cctag otherwise falls back to the paired terminal's working directory.

Plain shells and processes not registered as Herdr agents remain visible in
`herdr pane list` but do not appear in `herdr agent list`. Orca candidates are
discovered by Orca's own process-based backend, not by Herdr.

### What makes the Herdr path safe is choosing not to use that raw power

Herdr is just as capable as tmux underneath, but **cctag's Herdr path imposes
its own rule: only ever operate on a `pane_id` that came from `herdr agent
list`/`agent get`.** There's no Slack command that lets you target an
arbitrary pane.

(Before herdr 0.7.5 this was a `terminal_id`. 0.7.5 stopped accepting one as
an agent-command target, hence the move to `pane_id` — which also means a
pairing survives quitting the CLI and restarting it in the same pane.)

Put together:

- **Herdr's agent registry** limits candidates to supported, registered CLI
  agents (Claude Code and Codex CLI), not every managed pane
- **cctag's implementation choice** narrows down what it will actually
  *operate on* (only things discovered via the agent list)

Together, these rules let cctag operate only on supported agents in registered
panes; Herdr's raw pane commands remain capable of addressing arbitrary panes.

### Orca: process-based discovery and writes

When the Orca CLI is available (`CCTAG_ORCA_BIN`, default
`/opt/homebrew/bin/orca`), cctag combines Orca's terminal and worktree metadata
with the local agent process tree. It joins a process to an Orca terminal by an
exact `tabId:leafId` pane-key match. Only if no direct match exists may it use
the process's `ORCA_TERMINAL_HANDLE`, and only when that handle names an
explicitly orphaned terminal whose `tabId:leafId` pair is not another pane's
ordinary key.

Claude Code on Orca supports the same cctag features as Claude Code on Herdr.
Orca also supports `omp` text turns, output, and status. Codex is recognized
but not listed by this backend. When `omp` waits for input, cctag posts the
visible prompt when available and a notice to answer in the terminal; Slack
answers are not supported.

Before every Orca terminal write, cctag rechecks the foreground process
identity. For `omp`, it also verifies the identity of the transcript open for
writing. A pane whose agent or session cannot be verified is omitted rather
than guessed.

## 4. From `@cctag connect` to an actual conversation

1. **`@cctag connect`** (owner only) → posts a Slack button menu built from
   the enabled backends: Herdr's Claude Code/Codex agents and Orca's
   Claude Code/`omp` agents

   "Owner only" is not simply a narrowed permission. **The Spoke runs on the
   owner's own machine, so `connect` is choosing which of your own panes to
   expose to this thread.** Nobody else can run it because nobody else's panes
   are there — it is less an access rule than the shape of the thing. Once
   paired, anyone in the thread can talk to it (see "What this actually looks
   like in use" in the [README](../README.md)) — so what is restricted is
   *deciding what to attach*, not *using it*.
2. Pick one → that thread (channel + thread_ts) and the backend-qualified
   target (a Herdr pane or `orca:<paneKey>`) are recorded as a pairing

   Orca supports the same cctag features for Claude Code as Herdr, plus `omp`
   text turns, output, and status. OMP questions and approvals are reported to
   Slack but must be answered in the terminal; Codex is not listed on Orca.
   Before each Orca write, cctag rechecks the foreground process identity and,
   for `omp`, the open transcript identity.
3. For a Herdr-backed pairing, sending **`@cctag <message>`**:
   - Submits the text via herdr's `agent prompt`, which sends the text *and*
     the Enter in **one call**. Sending them separately raced Claude Code's
     paste handling: an Enter arriving before the injected text settled got
     absorbed as a newline, leaving the message unsent. `agent prompt`
     sequences both server-side, so there is no such race
   - Polls `agent get` every 1.5s for status (working/blocked/idle/done)
   - Meanwhile reads the Claude Code session's transcript
     (`~/.claude/projects/.../*.jsonl`) incrementally, collecting the
     assistant's reply text
   - **Whether the turn is over is decided from the transcript's own turn
     boundary** (`turn_duration` for Claude Code, the `task_complete` event
     for Codex). herdr's `idle`/`done` alone is not enough: a lingering
     background shell can make it report `working` indefinitely while the
     agent sits idle, and waiting on that never ends. See `src/settle.ts`
   - Once the turn finishes, posts the collected text back to Slack as one
     message

## 5. How multiple-choice prompts (AskUserQuestion, permission menus) work

This is where a real gotcha turned up during development.

Claude Code and Codex CLI do not write pending questions or permission prompts
to their transcripts until after they're answered. Claude Code's
`AskUserQuestion` question and answer land together as a single record, so
while the question is on screen the transcript shows nothing about it.

For these supported prompts, cctag reads the terminal screen through the
selected backend: Herdr pairings use `herdr pane read`, while Orca pairings use
Orca's terminal reader. A line reading `N. Type something.` identifies a
Claude Code `AskUserQuestion` menu; its absence means a permission menu.
`omp` follows a separate path: cctag posts a terminal-only notice, and the
prompt must be answered at the terminal.

For Slack-answerable Claude Code and Codex CLI prompts:

- **Click a button** → sends the chosen option through the selected backend.
- **Reply in the thread with free text** → supported when the prompt has a
  free-text row, such as Claude Code's "Type something"; cctag moves the
  on-screen cursor there, types the text, and presses Enter.

## 5.5 Work started without going through Slack

Everything in section 4 ("From `@cctag connect` to an actual conversation")
happens inside a **turn** — cctag only reads the transcript or watches
status while that turn is running.

So what happens if you start a conversation directly at the terminal
(Claude Code app), never touching Slack at all? **Nothing gets posted.**
There's no turn, so there's nothing watching.

That's awkward for a common workflow — start a long task at the terminal,
pair cctag partway through — so `src/watcher.ts`'s **background watcher**
covers this separately. It polls every paired instance with no active turn
roughly every 7 seconds; when one transitions from working to idle/done, it
posts the newly-produced text to the paired thread, prefixed with 🖥️.

To avoid replaying old history, the very first time it sees a pairing
(right after pairing, right after an active turn just finished, or after a
session rotation) it just records the transcript's current end as a
baseline — it only ever reports what happens after that point.

What if that terminal-driven work instead hits an AskUserQuestion or a
permission prompt? Just waiting for `idle`/`done` isn't enough — if no one
answers it, the terminal stays `blocked` forever, and the watcher would
never notice anything (this exact gap surfaced during development and is
what the following fix closes).

So instead of waiting, the moment the watcher sees `blocked` it hands that
terminal off to `TurnEngine.adoptBlockedTerminal()` — putting it on the
**same poll loop** a Slack-initiated turn uses and sending no new input (the
prompt is already on screen). Supported Claude Code and Codex CLI prompts then
use their existing Slack-button and terminal-answer paths, whether discovered
by the watcher or started from Slack.

`omp` is different: its prompt goes through the terminal-only notice path.
Slack receives a notice that tells the user to answer at the terminal; it
cannot be answered by button or thread reply. Once handed off, `watcher.ts`
stops tracking the terminal (`this.watches`); when it finishes, `TurnEngine`
removes it from `turns`, and the next poll cycle re-baselines it as a fresh
pairing.

## 5.6 Switching model

For Claude Code, `@cctag model <name>` (e.g. `model opus`) forwards Claude's
own `/model <name>` command rather than starting a normal conversational turn;
the command's output doesn't reliably land in the session transcript. Claude
Code model switching is supported on Herdr and Orca. `omp` has no model
command; Codex CLI uses its separate model and reasoning-level picker, covered
in [usage.md](usage.md).

The steps below describe the Herdr command path. Orca uses its guarded composer
channel for Claude Code.

`commands.ts`'s `runTuiCommand()`:

1. Sends the slash command via Herdr, then confirms it with Enter
2. Polls status; if it goes `blocked` (e.g. the "Switch model? Yes/No"
   confirmation that appears when switching models mid-conversation), the
   existing permission-menu parser (`parsePermissionMenu`) auto-confirms the
   first option — asking for the switch already expressed that intent
3. Once it settles (`idle`/`done`), reads the screen and relays the
   command's own output back to Slack as-is

Step 3's pane read has a gotcha: the TUI's screen always ends with a fixed
footer (a separator, an empty prompt, another separator, then
model/context/cwd/mode status lines). Reading only the last few lines lands
entirely inside that footer, missing the actual command output above it. So
cctag reads a larger chunk and cuts everything from the model/context
status line downward (a distinctive `ctx ... /rc` pattern), then trims the
separator/padding right above that (`stripFooterChrome()`).

`TurnEngine` has a separate `externallyBusy` set alongside its normal turn
tracking, so these TUI commands are treated as "busy" the same way an
active turn is — this keeps the background watcher (section 5.5) from
trying to watch the same instance a TUI command is currently driving.

## 5.6.1 Switching mode (the four Shift+Tab modes)

`@cctag mode <name>` (`manual` / `accept-edits` / `plan` / `auto`) works
differently from switching model. These four modes have **no slash
command** — the only way to change them in Claude Code is cycling with
Shift+Tab. On Herdr, `pane send-keys shift+tab` is accepted but
**delivers nothing Claude Code reacts to**. Empirically, sending the raw
CSI Z sequence (`\x1b[Z`, backtab) via `pane send-text` does work — exposed
as `HerdrClient.paneSendText()`.

Claude Code mode switching is also supported on Orca; that backend sends the
backtab through its guarded composer channel.

`runModeCommand()` matches the mode with a closed loop: read the current
mode off the footer status line (`⏸ manual mode on` / `⏵⏵ accept edits on` /
`⏸ plan mode on` / `⏵⏵ auto mode on`), and while it differs from the target,
send one CSI Z and re-read — repeating until it matches. Because it checks
after each press rather than computing a press count up front, it's robust
to the ring order or footer wording changing across versions. Two
safeguards: (1) if the current mode can't be read, it refuses to cycle
(there'd be no way to know where it landed), and (2) it presses at most one
full ring, so an unavailable target leaves the mode back where it started
rather than somewhere unpredictable. `@cctag plan` is shorthand for `mode
plan`.

## 5.6.2 Plan Mode over Slack

Claude Code Plan Mode works on Herdr and Orca. When a plan-mode turn finishes,
Claude Code shows a "Here is Claude's plan / ready to execute?" approval prompt
(a kind of permission menu). On detecting it, cctag:

- **attaches the full plan as a `.md` file**. The plan is written to
  `~/.claude/plans/<slug>.md`, and its path shows in the footer — but a
  narrow pane wraps and truncates that path, so the parsed path is only a
  hint: if it doesn't resolve to an existing file, cctag falls back to the
  **most-recently-modified file** in the plans directory (which Claude Code
  writes right before the prompt) — see `resolvePlanFile()`;
- posts **approval buttons** (proceed / proceed with auto mode);
- lets you **reply with changes in the thread**. The approval menu has a
  "Tell Claude what to change" free-text option; a plain thread reply is fed
  into it (move the cursor to that option's number, type the feedback,
  Enter), which regenerates the plan and stays in plan mode — so you can
  refine the plan from Slack before any code runs (`answerPlanFeedback()`).

Whether a prompt is a plan-approval prompt is decided by scanning only the
**active prompt region** — from the bottom-most cursor line down — for the
"Tell Claude what to change" marker. That way it (1) doesn't miss the option
when a narrow pane wraps an earlier option's label and cuts
`parsePermissionMenu`'s consecutive-number scan short, and (2) doesn't
misfire on the same line left in scrollback by an earlier, already-resolved
plan prompt (which sits above the current cursor). The "Tell Claude what to
change" option itself isn't rendered as a button — pressing its number only
moves the cursor without confirming, so changes are taken via free-text
reply instead.

## 5.7 Catching up on messages cctag wasn't mentioned in

cctag normally only ever sees the literal text of a message that mentions
it. A review posted by another Slack bot (like `@Claude`) or a teammate
elsewhere in the same thread is otherwise invisible to it unless someone
manually copies it into an `@cctag` message.

`@cctag log [instruction]` closes that gap. Rather than guessing intent
from wording, it looks up the thread's actual history via Slack's
`conversations.replies` API, mechanically finds **cctag's own last
message** in that thread, and takes everything posted after it. Each
message is formatted as `sender: text` (human display names resolved via
`users.info`, bot names via `bot_profile.name`/`username`), then fed into
the paired session as one turn — reusing `startTurn()` unchanged, so any
permission prompt or AskUserQuestion that comes up mid-turn is handled by
the same existing machinery. With no instruction, it defaults to "act on
whatever the log contains"; with one, that instruction is appended
instead. If nothing's been posted since cctag's last message, it says so
rather than starting a no-op turn.

`Notifier` gains an optional `getThreadHistorySinceLastBotPost?`, mirroring
`getPermalink?`'s design: `SlackNotifier` implements it directly for
standalone mode, while Hub–Spoke mode proxies it through a `get_thread_history`
RPC call the Hub executes (since the Hub is the side holding the real Slack
client there). The actual formatting logic
(`formatThreadHistorySinceLastBotPost`) lives once in `slack/notifier.ts`
and is shared by both paths.

## 5.8 How file attachments work (Slack ⇄ agent)

### Inbound: why handing over a path is enough

An image pasted into Slack arrives in the message's `files[]`, never in its
`text`. cctag downloads it to `~/.cctag/inbox/<file_id>-<name>` and appends
the paths to the prompt, one per line (`buildPromptWithAttachments()`).

Claude Code converts an image path in a prompt into a real image attachment.
This behavior is specific to Claude Code:

- the path text is removed and replaced by an `[Image #N]` placeholder (which
  moves to the front of the text)
- the bytes land in the transcript as a separate base64 `image` block
- one extra record is appended noting `[Image: source: <path>]`
- the `Read` tool is never called — no extra tool round trip
- a path outside the cwd triggers no permission prompt, precisely because
  `Read` isn't involved
- paths containing spaces and non-ASCII (`スクリーンショット 2026-07-27
  14.02.33.png`) work unquoted

Base64-in-the-prompt was rejected on token grounds. Measured on a 2.8MB PNG:
~3.6k tokens this way (Claude Code re-encodes it to JPEG and downscales first)
versus ~170k as text — ~50x — and the text version isn't an image to the model
at all.

Other agents receive paths, not a cctag-created image block; their own file
tools determine how those files are read.

### The inbound catch: an image path swallows the Enter

`herdr agent prompt` sequences the text injection and the Enter server-side, but
**a prompt carrying an image path doesn't submit — it sits in the input box.**
The path→attachment conversion is asynchronous and the Enter is absorbed while
it runs. A prompt with only non-image paths submits immediately, so this is
specific to images (measured: 500ms–1000ms to convert a 2.8MB PNG).

The existing "resend Enter if nothing was submitted" safety net (`0d4c830` /
`624389c`) waited once and retried once, so it's now a bounded loop of
`SUBMIT_RETRIES_WITH_IMAGES` attempts. An Enter into an empty box is a harmless
no-op, which is why erring toward over-retrying is the safe direction.

### Outbound: two routes

`Notifier.uploadFile?` (bytes as base64) sits alongside the `uploadTextFile?`
used for plan attachments, with the same shape: standalone goes straight through
`SlackNotifier`, Hub–Spoke goes through an `upload_file` RPC the Hub executes.
What gets sent is decided by two routes:

- **`<cwd>/.cctag/outbox/`** — the directory is snapshotted at turn start
  (name → `mtime:size`) and anything new or changed at turn end is uploaded.
  Per-cwd rather than global because several threads can be paired to different
  panes at once, and a shared outbox would post one pane's files into another
  pane's thread. Uploaded files are left in place — consuming a directory the
  user also writes to is hard to undo — and the mtime/size comparison keeps an
  untouched file from being re-sent.

  Per-cwd still leaves an ambiguity when **two panes share one cwd**. So
  whenever the outbox has additions, cctag asks its live terminal list for every
  pane's cwd and checks whether another pairing points at the same one. If one
  does — or if the listing can't be fetched — it skips the outbox, says why in
  the thread, and leaves the files alone. Transcript detection is unaffected:
  those paths come from this turn's own transcript.
- **Transcript detection** — Claude Code's `SendUserFile` `input.files`. The
  agent states outright that it wants a file delivered, so nothing is filtered
  by type, and its `caption` becomes the upload comment. Paths come from
  `input.files`, resolved against the pane's cwd (`tool_result` carries
  absolute paths but in an undocumented human-readable format, so it is used
  only for its success bit).

  This replaced detecting `Write` `file_path`s narrowed to images/SVG/PDF, which
  inferred "send this" from "a file changed": it posted artifacts nobody asked
  for, needed an extension allowlist that dropped legitimate `.csv` and `.md`
  files, and still missed the common case, since files produced by Bash (a
  matplotlib PNG) leave no recoverable path in the transcript. Codex CLI and
  `omp` have no equivalent tool, so `.cctag/outbox` is their only automatic
  outbound file route.

  Crucially, **the `tool_use` alone must not be trusted.** A request and its
  result are separate records that routinely arrive in different poll batches,
  and a denied call changes nothing — acting on the request alone would have
  cctag read and upload a file the human just refused to release (measured: a
  denial records `is_error: true` on the `tool_result`). `WrittenFileTracker`
  therefore correlates request and result by `tool_use_id` and only surfaces
  **confirmed** calls.

### Hub–Spoke file flow and authorization

A Spoke holds no bot token, so the Hub always performs the download. The Hub
forwards the file metadata it saw on the event *and* records **which file id it
offered to which owner** (`fileOwner`, capped at 500), and the `fetch_file` RPC
serves only ids in that record for that owner. Without it, a Spoke could name
any file id and pull down anything the bot can see. The download URL itself is
never handed to the Spoke; the Hub re-resolves it from Slack.

A transfer moves megabytes of base64 in one JSON message and includes a Slack
API round trip, which the RPC's 20s default (sized for `chat.postMessage`)
doesn't cover — file calls use 120s instead. The caps
(`CCTAG_MAX_FILE_MB` / `CCTAG_MAX_FILE_COUNT`) are enforced on both the Spoke
and the Hub.

Because **Hub and Spoke ship independently**, a Hub that predates `upload_file`
answers `no handler for ...`. That's reported to the thread once as "the Hub
needs updating" rather than as a transfer failure (`isUnsupportedByRemote()`).

## 6. Connecting one PC to more than one Slack workspace

A Hub is tied to exactly one workspace (by its Slack app token). To reach a
second workspace, you run a second Hub (it can live on the same server)
and a second Spoke on your own PC.

In that case, **both Spokes use the same local terminal backends** (Herdr
daemon and/or Orca runtime), so a terminal paired in one workspace can also
show up in the other workspace's `connect` picker. Avoid pairing the same
terminal from both at once — the keystrokes would collide.

## 7. Security notes

- Anyone who can post in a paired thread can send text into a
  full-permission local agent. Only pair threads in channels with people
  you trust
- Supported Claude Code and Codex CLI permission prompts can be answered with
  Slack buttons or at the terminal. OMP prompts are reported in Slack as
  terminal-only notices and cannot be answered there.
- A Hub token (`token issue <name> <ownerUserId>`) is bound to the Slack
  user ID it was issued for and can't register as anyone else — but it can
  still act on that owner's own paired threads, so only hand tokens to
  people you trust

## See also

- Source: https://github.com/TMLlaboratory/cctag
- herdr: https://herdr.dev
