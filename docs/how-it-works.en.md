🌐 [日本語](how-it-works.md) | **English**

---

This document explains how cctag works internally (for setup steps, see the [README](../README.md)).

# How cctag works

## 1. What this tool does

**cctag bridges a Slack thread to a Claude Code terminal session running on
your own machine.**

Anthropic's official "Claude Tag" (`@Claude` in Slack) runs Claude Code in a
sandbox Anthropic hosts in the cloud. It can't reach your local files or
network (internal servers, GPUs, local model endpoints, etc.) directly.

cctag does the opposite: it remote-controls **a Claude Code instance you
are actually running on your own PC right now**. Start `claude` in your
terminal, and you can talk to that exact session from Slack — send it
instructions and get its replies back.

```
Slack thread (@cctag)
        ↕
   cctag (Hub / Spoke)
        ↕
      herdr
        ↕
   Claude Code (on your PC)
```

## 2. Overall shape: Hub and Spoke

So that multiple people can share a single `@cctag`, cctag splits into two
roles.

| | Role | Runs on | Can do |
|---|---|---|---|
| **Hub** | The one connection to Slack | A small always-on server (e.g. a small cloud VM) | Receives Slack messages and forwards them to the right person's Spoke. **Never touches Claude Code or herdr itself** |
| **Spoke** | The thing that actually drives Claude Code | **Your own PC** | Sends keystrokes into your local Claude Code via herdr, reads its output, and relays it back to Slack through the Hub |

The important part: **the Hub has no way to reach your terminal.** Even if
the Hub's server were compromised, it has no ability to control the Claude
Code running on your machine — only the Spoke running on your own PC can
actually do that. So anyone who wants to control their own PC's Claude Code
from Slack needs to have **their own Spoke running on their own PC**.

## 3. How this relates to herdr: why only "running agents" show up

cctag doesn't drive the terminal directly — it goes through
[herdr](https://herdr.dev). There are two layers to how that scopes things
down.

### herdr itself can write to any pane

herdr is fundamentally a tmux-like terminal multiplexer. Commands like
`pane read` (read the screen) and `pane send-keys` (send keystrokes) work
on **any pane herdr manages**, whether Claude Code is running in it or it's
just a plain shell. The in-house bridge that used raw tmux before herdr
(cc-slack-bridge v4) used exactly this raw power — it could send anything
to a hardcoded pane number, for better or worse.

### Only self-reported panes show up in the "agent list"

On the other hand, what shows up in `herdr agent list` (the command cctag
uses to build the `@cctag connect` picker) is **only panes where Claude
Code itself has told herdr "I'm running here."** Claude Code has a
`SessionStart` hook that fires on startup and reports to herdr's socket:
"session ID xxx is running in this pane." Only once that report arrives
does the pane get listed as an "agent."

So even when herdr is managing many panes, `herdr agent list` shows only
the ones where Claude Code is running and self-reporting. The rest (plain
shells, etc.) show up in `herdr pane list` but never in `herdr agent list`.

### What actually makes cctag safe is choosing not to use that raw power

herdr is just as capable as tmux underneath, but **cctag's code imposes its
own rule: only ever operate on a `terminalId` that came from `herdr agent
list`/`agent get`.** There's no Slack command that lets you target a raw
`pane_id` directly.

Put together:

- **herdr's self-reported registry** narrows down what's even a *candidate*
  (only panes running Claude Code)
- **cctag's implementation choice** narrows down what it will actually
  *operate on* (only things discovered via the agent list)

Both together are what produce the safe behavior of "only touches running
Claude Code agents, can't freely drive an arbitrary terminal." herdr the
tool doesn't forbid this on its own — it's a restriction that comes from
how cctag chooses to use it.

## 4. From `@cctag connect` to an actual conversation

1. **`@cctag connect`** (owner only) → posts a Slack button menu built from
   whatever `herdr agent list` finds
2. Pick one → that thread (channel + thread_ts) and the chosen terminalId
   are recorded as a "pairing" (one thread per terminal at a time)
3. In a paired thread, sending **`@cctag <message>`**:
   - Injects the text via herdr's `agent send`, then an Enter via
     `pane send-keys`
   - Polls `agent get` every 1.5s for status (working/blocked/idle/done)
   - Meanwhile reads the Claude Code session's transcript
     (`~/.claude/projects/.../*.jsonl`) incrementally, collecting the
     assistant's reply text
   - Once the turn finishes (idle/done), posts the collected text back to
     Slack as one message

## 5. How multiple-choice prompts (AskUserQuestion, permission menus) work

This is where a real gotcha turned up during development.

**Claude Code does not write an `AskUserQuestion` (multiple-choice
question) to its transcript until after it's answered.** The question and
its answer land together, as a single record, the moment it's answered.
While the question is still on screen, the transcript shows nothing about
it at all.

So detecting a pending question or a pending permission prompt (e.g. "Do
you want to run this tool?") can't use the transcript — it has to **read
the screen itself via `herdr pane read`** and parse the menu with a regex.
A line that reads `N. Type something.` means it's an AskUserQuestion menu;
its absence means it's a permission menu.

There are two ways to answer:

- **Click a button** → sends the matching digit key straight through herdr
  (confirmed on real hardware: a single digit both selects *and* confirms
  — no Enter needed)
- **Reply in the thread with free text** → moves the on-screen cursor down
  to the "Type something" row with the Down arrow key, types the text, and
  presses Enter

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
**exact same `pollLoop()`** a Slack-initiated turn uses, sending no new
input (the prompt is already on screen). That means the AskUserQuestion/
permission parsing, Slack button posting, button-click and free-text
answering, and "answered directly at the terminal" detection are all the
same existing code, whether the turn started from Slack or was discovered
mid-flight at the terminal. Once handed off, `watcher.ts` stops tracking it
(removed from `this.watches`); when it finishes, `TurnEngine` removes it
from `turns`, and the next poll cycle re-baselines it as a fresh pairing.

## 5.6 Switching model

`@cctag model <name>` (e.g. `model opus`) is handled by a separate path
from a normal conversational turn. It just forwards Claude Code's own slash
command (`/model <name>`) as-is, and isn't treated as a `TurnEngine` turn
(its output doesn't reliably land in the session transcript the way an LLM
reply does).

Instead, `commands.ts`'s `runTuiCommand()`:

1. Sends the slash command via herdr, then confirms it with Enter
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
Shift+Tab. And herdr's `pane send-keys shift+tab`, though accepted,
**delivers nothing Claude Code reacts to**. Empirically, sending the raw
CSI Z sequence (`\x1b[Z`, backtab) via `pane send-text` does work — exposed
as `HerdrClient.paneSendText()`.

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

When a plan-mode turn finishes, Claude Code shows a "Here is Claude's plan /
ready to execute?" approval prompt (a kind of permission menu). On detecting
it, cctag:

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
`text`. cctag downloads it to `~/.cctag/inbox/<file_id>-<name>` and simply
appends the paths to the prompt, one per line
(`buildPromptWithAttachments()`).

That works because **Claude Code converts an image path in a prompt into a real
image attachment.** Measured behavior:

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

Non-image files (PDF, CSV, ...) stay plain paths for the agent to open with its
own `Read` tool.

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
- **Transcript detection** — `Write` tool `file_path`s, narrowed to
  images/SVG/PDF. Only `Write` is inspected because it's the one tool whose
  input names its output. Files produced by Bash (a matplotlib PNG) leave no
  recoverable path in the transcript, which is exactly the gap the outbox
  convention fills. Source files and `.md` are excluded: the agent writes those
  constantly and uploading each one would bury the thread.

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

In that case, **both Spokes are looking at the same herdr daemon**, so a
terminal paired in one workspace also shows up in the other workspace's
`connect` picker. Avoid pairing the same terminal from both at once — the
keystrokes would collide.

## 7. Security notes

- Anyone who can post in a paired thread can send text into a
  full-permission local agent. Only pair threads in channels with people
  you trust
- Permission prompts (e.g. confirming a dangerous command) still require a
  human's approval via Slack buttons — nothing runs unattended
- A Hub token (`token issue <name> <ownerUserId>`) is bound to the Slack
  user ID it was issued for and can't register as anyone else — but it can
  still act on that owner's own paired threads, so only hand tokens to
  people you trust

## See also

- Source: https://github.com/moiku/claude-code-tag
- herdr: https://herdr.dev
