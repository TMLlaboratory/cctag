What you can do from a Slack thread once it is paired. For getting to that
point, see [spoke-setup.md](spoke-setup.md).

# Usage

In a Slack channel with `@cctag` invited, start a thread and mention the
bot:

| Command | Who | What it does |
|---|---|---|
| `@cctag connect` | owner | Lists running herdr agents (Claude Code and Codex CLI); pick one to pair with this thread |
| `@cctag disconnect` | owner | Unpairs this thread |
| `@cctag status` | anyone | Shows the paired instance and its live status |
| `@cctag list` | anyone | Lists all running agents and which are paired |
| `@cctag model <name> [level]` | anyone (in a paired thread) | Switches the paired session's model — Claude Code: runs `/model <name>` (e.g. `model opus`); Codex CLI: drives its model + reasoning-level picker (e.g. `model gpt-5.6-sol high`) |
| `@cctag mode <name>` | anyone (in a paired thread) | Claude Code only — switches the Shift+Tab mode: `manual` / `accept-edits` / `plan` / `auto` |
| `@cctag plan` | anyone (in a paired thread) | Claude Code only — enables Plan Mode (same as `mode plan`) |
| `@cctag log [instruction]` | anyone (in a paired thread) | Feeds thread messages since cctag's last post (not just @cctag mentions) into the paired session, optionally with an instruction |
| `@cctag <anything else>` | anyone (in a paired thread) | Sends the text into the paired session; its reply is posted back in the thread |

`mode`/`plan` reply with a "not supported" message rather than erroring when
the paired thread is on a Codex CLI instance.

Only one thread can be paired to a given terminal at a time. Only single-word
messages (`connect`, `status`, ...) are treated as commands — anything with a
space, including a message that merely *starts* with a command word, is
sent to the paired agent as a turn.

When the paired agent is waiting on a decision, cctag posts buttons in the
thread:

- **AskUserQuestion** (Claude Code only): one button per option; click one,
  or just reply in the thread with free text for a custom answer.
  Multi-select questions aren't rendered as buttons (toggling checkboxes
  reliably over a terminal isn't robust yet) — reply in the thread listing
  what you'd pick instead.
- **Permission / command-approval prompts** (e.g. "Do you want to run `rm
  -rf ...`?" on Claude Code, or Codex CLI's "Would you like to run the
  following command?"): one button per choice, first option styled primary,
  anything that looks like a refusal ("No", "Cancel", "拒否") styled as a
  danger button.

## Sending files and images to the agent

Attach a file (or just paste an image) to an `@cctag` message and the paired
session receives it. cctag downloads it to `~/.cctag/inbox/` and puts the path
in the prompt; Claude Code turns an image path into a real image attachment —
what the TUI shows as `[Image #1]` — so the model actually *sees* the
screenshot. A message that's nothing but an image works too.

The path is deliberate, not incidental: base64 pasted into the prompt as text
would cost roughly 50x the tokens (measured: a 2.8MB PNG is ~3.6k tokens
attached this way, vs ~170k as text) and wouldn't be an image to the model at
all. Non-image files (PDF, CSV, ...) arrive as paths for the agent to open with
its own file-reading tool.

Two things to know:

- **The mention is required.** Dropping an image into a paired thread without
  `@cctag` does nothing, same as any other unmentioned message — otherwise
  every screenshot people share with each other would start a turn.
- **Caps.** `CCTAG_MAX_FILE_MB` (default 10) and `CCTAG_MAX_FILE_COUNT`
  (default 5) per message; anything rejected is reported in the thread rather
  than silently dropped. Downloads are pruned after 7 days.

## Getting files back out

Two ways, both automatic — no command to remember:

- **`<cwd>/.cctag/outbox/`** — anything the agent puts there during a turn is
  uploaded to the thread when the turn ends. Any file type. This is the one
  that covers charts, since a matplotlib PNG is written by a shell command that
  leaves no trace of its output path in the transcript. Worth telling your
  agent about once, e.g. in the project's `CLAUDE.md`:

  ```markdown
  Slack に見せたい画像や PDF は `.cctag/outbox/` に置く（cctag が自動で添付する）。
  ```

  Add `.cctag/` to `.gitignore`. Uploaded files are left in place, and a file
  only re-uploads if it changes.

  The directory is keyed by working directory, so if two panes are open on the
  same repository *and* paired to different threads, cctag can't tell whose
  file is whose — in that case it skips the outbox, says so in the thread, and
  leaves the files on disk rather than posting them to the wrong place.

- **`SendUserFile`** — Claude Code's own "hand this to the user" tool. Files it
  names are uploaded without any outbox involvement, whatever their type, and
  its `caption` becomes the upload comment. Only calls that actually succeeded
  count: deny the permission prompt and cctag uploads nothing.

  This replaced detecting `Write` calls, which inferred "send this" from "a file
  changed" — so it posted artifacts nobody asked for, needed an extension
  allowlist that dropped legitimate `.csv` and `.md` files, and missed the
  common case anyway, since a chart written by a shell command leaves no path in
  the transcript. Codex CLI has no equivalent tool, which is why the outbox
  stays its only route.

## Switching model

`@cctag model <name> [level]` switches the paired session's model directly,
rather than starting a conversational turn — mechanics differ by agent:

- **Claude Code** runs `/model <name>` and reports back the command's own
  output (e.g. "Set model to Opus and saved as your default for new
  sessions"), read straight off the terminal screen. If switching models
  mid-conversation triggers a confirmation menu ("Switch model? Yes/No"),
  it's auto-confirmed, since asking for the switch already expressed that
  intent.
- **Codex CLI** has no `/model <name>` argument — its `/model` opens a
  two-stage picker (pick a model, then pick a reasoning effort level: `low`
  / `medium` / `high` / `extra high`, though which levels are offered
  varies by model). cctag drives that picker for you: `@cctag model
  gpt-5.6-sol high` picks the model and the level in one go; `@cctag model
  gpt-5.6-sol` alone picks the model and leaves its current/default level
  as-is. An unrecognized model or level name gets a reply listing the
  actual candidates read off that screen.

## Switching mode

*(Claude Code only — Codex CLI has no equivalent mode ring; `mode`/`plan`
reply with a not-supported message on a Codex-paired thread.)*

`@cctag mode <name>` selects one of Claude Code's four Shift+Tab modes —
`manual`, `accept-edits`, `plan`, `auto`. There's no slash command for
these; the only control is cycling with Shift+Tab, so cctag reads the
current mode off the terminal footer and cycles one press at a time until
it reaches the target (a raw backtab control sequence — herdr's plain
`send-keys shift+tab` doesn't register with Claude Code). If the target
isn't reachable (not present in that Claude Code build), it reports so and
leaves the mode exactly where it started. `@cctag plan` is a shorthand for
`mode plan`. These commands are blocked while a turn is in progress on the
same instance.

## Plan Mode over Slack

*(Claude Code only.)*

When a plan-mode turn finishes and Claude Code shows its "ready to code?"
approval prompt, cctag:

- **attaches the plan** to the thread as a downloadable `.md` file (read
  from `~/.claude/plans/`), on top of the approval buttons, so the full
  plan is readable even where the terminal render is line-wrapped;
- lets you **approve with a button** (proceed / proceed + auto-accept), or
- lets you **reply with changes in the thread** — a plain reply is routed
  into Claude Code's "tell it what to change" path, which refines the plan
  and stays in plan mode, so you can iterate on the plan from Slack before
  any code runs.

## Catching up on thread activity cctag wasn't mentioned in

cctag only ever sees the literal text of messages that mention it — a
review posted by another Slack bot or a teammate elsewhere in the thread is
otherwise invisible to it. `@cctag log` closes that gap: it fetches every
message posted after cctag's own last message in the thread (found by
looking up the thread's actual history, not by guessing from wording),
formats each as `sender: text` (resolving human display names and bot
names), and feeds the result into the paired session as context. With no
instruction, it defaults to "act on whatever the log contains"; with one
(`@cctag log <instruction>`), that instruction is appended instead. If
nothing's been posted since cctag's last message, it says so instead of
starting a no-op turn.

## Work started outside of Slack

cctag only actively watches a paired instance while a Slack-initiated turn
is running. If you start something directly at the terminal — before ever
pairing, or a long task you kicked off locally and paired mid-run — a
background watcher (polling every ~7s) notices once it settles
(working → idle/done) and posts the new output to the paired thread,
prefixed with 🖥️. It never replays old history, so pairing mid-task only
reports what happens *after* pairing.

If that terminal-driven work instead hits an `AskUserQuestion`, permission,
or (Codex CLI) command-approval prompt, the watcher doesn't just wait for
it to resolve on its own — it hands the terminal off to the same turn
machinery a Slack-initiated message uses, so the prompt gets posted as
Slack buttons (and can be answered from the thread) even though nothing was
ever sent via `@cctag`.

Multi-question `AskUserQuestion` prompts (Claude Code only) are answered
one question at a time — after you answer, cctag reads the next one off
the screen.
