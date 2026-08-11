🌐 [日本語](README.ja.md) | **English**

---

# cctag

<img src="assets/icon.png" alt="cctag icon" width="120" />

Bridge a Slack thread to a **locally running coding-agent TUI session** —
Claude Code or Codex CLI — the way
[Claude Tag](https://www.anthropic.com/news/introducing-claude-tag) bridges
Slack to a cloud session — except cctag drives *your own terminal*.

```
Slack thread (@cctag)
   ⇅ Socket Mode (@slack/bolt) — no public server required
cctag daemon (Node/TS, runs on your machine)
   ├─ inject:  herdr pane send-text <pane_id> <text> + Enter
   ├─ detect:  herdr agent get      <pane_id>  (idle / working / blocked / done)
   ├─ read:    the paired agent's own session transcript
   │             Claude Code: ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
   │             Codex CLI:   ~/.codex/sessions/YYYY/MM/DD/rollout-*-<session-id>.jsonl
   └─ pairing: thread (channel, thread_ts) ⇔ herdr pane_id
```

cctag controls the paired agent through [herdr](https://herdr.dev) (a terminal
workspace manager) rather than screen-scraping tmux — agent discovery,
keystroke injection, and status detection all go through the `herdr` CLI.
Turn output is read from the agent's own structured JSONL transcript, not
parsed off the screen. herdr reports which CLI is running in each pane
(`claude` or `codex`), and cctag picks the matching driver automatically, so
one `@cctag` bot can be paired to either kind of session — see [Agent
support](#agent-support) for what differs between them.

## What this actually looks like in use

### One shared session, more than one person driving it

Pairing a thread to an agent session doesn't restrict who can talk to
it — anyone in that thread can. In practice this means two people with
different expertise can both instruct the *same* session directly, instead
of one of them acting as a manual relay between the other and the AI: a
domain specialist asks it to work through a domain question, an engineer
asks it a separate implementation question in the same thread, and the
session picks up context from both without either person needing to
translate for the other.

The same shape shows up outside research, too. A common failure mode for
deploying an AI coding agent with a client is needing one person who's
simultaneously good at customer discovery *and* good at engineering — a
high bar, close to what people mean by "Forward Deployed Engineer." Letting
a customer-facing person and an engineer both drive one shared session
lowers that bar: the customer-facing person runs the discovery
conversation, the engineer handles anything that needs deeper technical
judgment, and — because the customer-facing person is present for and
gradually absorbs the technical exchange rather than receiving it
secondhand — the split isn't static. Over repeated use they typically pick
up enough fluency to drive routine work themselves, and the engineer's
role narrows toward the critical moments that still need it.

### Claude Tag for discussion, cctag for the work itself

If you also use [Claude Tag](https://www.anthropic.com/news/introducing-claude-tag)
(Anthropic's own Slack bot), the two pair naturally rather than overlap.
Claude Tag starts with zero memory every time, but a shared GitHub repo
gives it continuity anyway: point it at a repo's existing docs to pick up
prior context, and have it push a summary of a discussion's conclusions
back before the thread ends. cctag then picks up from there for anything
that's long-running, resource-heavy, or needs your own machine's tools and
files rather than a sandbox.

cctag doesn't try to absorb what Claude Tag does, deliberately — they sit
at different points in the same workflow. A casual, exploratory discussion
(a "seminar") and a long real execution run (a "production job") are
different modes and probably shouldn't share an environment; keeping them
as two tools connected through an ordinary GitHub repo, rather than one
tool trying to do both, is the point, not a gap to close.

## Status

**v0.1.** Text-in / text-out turns work end-to-end for both **Claude Code**
and **Codex CLI**. Multiple-choice prompts are also supported: when the
paired agent shows a tool-permission (or Codex command-approval) menu, cctag
renders it as Slack buttons and answers are sent back into the terminal for
you. If someone answers directly at the keyboard instead, the Slack message
updates to say so.

Note on how this works: neither agent writes a pending permission/question
prompt to its session transcript until *after* it's answered (Claude Code's
`AskUserQuestion` tool call is written atomically with its result), so
pending prompts are read directly off the terminal screen via `herdr pane
read`, not from the transcript. See `src/agents/claude/prompts.ts` and
`src/agents/codex/prompts.ts`.

### Agent support

| Feature | Claude Code | Codex CLI |
|---|:---:|:---:|
| Turns (text in / text out) | ✅ | ✅ |
| Tool-permission / command-approval prompts as Slack buttons | ✅ | ✅ |
| `AskUserQuestion` buttons + free-text answers | ✅ | — *(no equivalent tool)* |
| `@cctag model` | ✅ `/model <name>` | ✅ model + reasoning-level picker |
| `@cctag mode` / `@cctag plan` | ✅ | — *(no Shift+Tab mode ring or plan mode)* |
| Plan-file attach on ExitPlanMode | ✅ | — |
| Background watcher (terminal-initiated work) | ✅ | ✅ |
| Slack → agent image/file attachments | ✅ real image attachments | ✅ *(read via an `exec` step)* |
| Agent → Slack file uploads (`.cctag/outbox`) | ✅ | ✅ |
| Agent → Slack uploads detected from the transcript | ✅ `SendUserFile` | — *(no equivalent tool)* |

Where a feature isn't supported, cctag replies saying so rather than failing
silently — e.g. `@cctag mode plan` on a Codex-paired thread.

For a fuller walkthrough of the mechanism (aimed at lab students, written
before Codex support landed but still accurate for Claude Code's internals)
— Hub/Spoke roles, how herdr's agent registry differs from raw pane access,
the AskUserQuestion detection quirk, multi-workspace caveats — see
[docs/how-it-works.md](docs/how-it-works.md) (日本語) /
[docs/how-it-works.en.md](docs/how-it-works.en.md) (English).

## Two ways to run cctag

- **Standalone** — you create your own Slack app and run everything on one
  machine. Simplest option if you're the only person using cctag.
- **Hub–Spoke** — one shared Slack app, one always-on **Hub**, and one
  lightweight **Spoke** per person. Needed as soon as more than one person
  wants to use the same `@cctag` bot: Slack's Socket Mode delivers each
  event to exactly one of an app's open connections, so two people each
  running a full daemon against the same Slack app token would steal each
  other's events instead of sharing them. The Hub holds the single Socket
  Mode connection and only routes events; it never runs or sees anyone's
  coding-agent session. Each Spoke connects out to the Hub over an
  authenticated WebSocket and drives that person's own local herdr-managed
  instances (Claude Code, Codex CLI, or both), exactly like standalone mode
  does.

**If someone else already runs a Hub for your lab/team** (e.g. your
supervisor), you only need [For Spoke users](#for-spoke-users) below —
skip straight there, none of the Slack app setup applies to you.

## Requirements

- **Node.js 20+** — needed everywhere cctag runs (Hub, Spoke, or standalone).
- **[herdr](https://herdr.dev)**, installed and running, with your Claude
  Code and/or Codex CLI instance(s) started as herdr agents — needed only on
  machines that actually run one of these CLIs (standalone setups and every
  Spoke). A Hub-only machine never runs either and doesn't need herdr at all.
- **A Slack workspace where you can create an app** (Socket Mode; no public
  server or open ports needed) — needed only if you're creating the Slack
  app yourself (standalone or Hub operator). Spoke users never touch Slack
  app credentials.

### Installing herdr (macOS notes)

Install herdr with **one** method — Homebrew or the [official
installer](https://herdr.dev) — not both; mixing them leaves two `herdr`
binaries on `PATH` and makes `CCTAG_HERDR_BIN` ambiguous.

```bash
brew install herdr
brew services start herdr   # herdr runs as a background daemon via launchd
```

Register your terminal as a herdr agent — the agent name comes *first*,
before `--cwd`. Do this once per CLI you want to use (Claude Code, Codex CLI,
or both):

```bash
# Claude Code
herdr agent start <name> --cwd <project-dir> -- claude
herdr integration install claude

# Codex CLI
herdr agent start <name> --cwd <project-dir> -- codex
herdr integration install codex
```

If Node is managed by `nvm`, the launchd-started herdr daemon doesn't
source `.zshrc`/`.zshenv` and only sees a minimal `PATH`
(`/usr/bin:/bin:/usr/sbin:/sbin`), so it can't find `claude`/`codex` or
`node`. Pass the nvm bin directory explicitly:

```bash
herdr agent start <name> --cwd <project-dir> \
  --env PATH="$HOME/.nvm/versions/node/<version>/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
  -- claude
```

Check `herdr agent list` shows your agent as `idle`, with the `agent` field
reading `claude` or `codex` as expected, before continuing.

Codex CLI's full session-id reporting to herdr requires trusting its
`herdr-agent-state.sh` SessionStart hook once, interactively, the first time
Codex runs with the integration installed (a one-time approval prompt, like
its directory-trust dialog) — cctag works without it too, falling back to
locating the session by matching the paired terminal's working directory
instead.

## For Hub operators

*(Skip this whole section if you're connecting to a Hub someone else
already runs — see [For Spoke users](#for-spoke-users) instead.)*

### Create the Slack app

1. From `manifest.yaml`: https://api.slack.com/apps → *Create New App* →
   *From an app manifest* → paste `manifest.yaml` → pick your workspace.
2. Under **Basic Information → App-Level Tokens**, create a token with the
   `connections:write` scope. This is `SLACK_APP_TOKEN` (`xapp-...`).
3. **Install the app** to your workspace. Under **OAuth & Permissions**,
   copy the **Bot User OAuth Token** — this is `SLACK_BOT_TOKEN` (`xoxb-...`).
4. (Optional) Under **Basic Information → Display Information**, upload
   `assets/icon-512.png` as the app icon.
5. Invite the bot to a channel: `/invite @cctag`.

> **Upgrading an app created before file attachments landed:** `manifest.yaml`
> gained the `files:read` scope, and a scope change only takes effect on
> reinstall. Paste the current manifest over the app's existing one
> (*Features → App Manifest*), then reinstall to the workspace. Until you do,
> everything else keeps working and inbound attachments fail with a
> "couldn't download" notice in the thread.

### Running standalone

Find your own Slack user ID (three-dot menu on your profile → *Copy member
ID*) — this is `CCTAG_OWNER_USER_ID`. Only this user can run
`connect`/`disconnect`.

```bash
cp .env.example .env
$EDITOR .env   # SLACK_BOT_TOKEN, SLACK_APP_TOKEN, CCTAG_OWNER_USER_ID, CCTAG_HERDR_BIN
npm install
npm run dev   # or: npm run build && npm start
```

`npm run typecheck` and `npm test` cover the parts that are cheap to check
without a live Slack workspace — attachment limits, the outbound-file rules,
denied-write correlation, and the download size guard. The parts that need a
real terminal (prompt submission, permission prompts) are verified by hand
against a disposable herdr pane.

### Running a Hub (for more than one person)

The Hub needs the same `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN` as standalone
mode, plus a public `wss://` endpoint (a domain + TLS in front of it —
[Caddy](https://caddyserver.com) gets you automatic HTTPS with almost no
config). A single Oracle Cloud "Always Free" `VM.Standard.E2.1.Micro`
instance is plenty. This machine does **not** need herdr, Claude Code, or
Codex CLI.

```bash
git clone https://github.com/moiku/claude-code-tag.git /opt/cctag
cd /opt/cctag && npm install && npm run build
cat > .env <<EOF
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
CCTAG_HUB_PORT=8765
EOF
```

Point a domain at the box (an A record, DNS-only / not proxied through
Cloudflare or similar — Caddy needs to complete its own ACME/TLS handshake)
and give Caddy a one-line `/etc/caddy/Caddyfile`:

```
your.domain.example {
	reverse_proxy localhost:8765 {
		transport http {
			dial_timeout 5s
			response_header_timeout 15s
		}
	}
}
```

The explicit transport timeouts matter on a resource-constrained free-tier VM:
without them, a stalled Hub process (or a stalled TLS handshake under memory
pressure) leaves the client hanging indefinitely instead of failing fast.

Run the Hub under systemd (`ExecStart=/usr/bin/node dist/hub/index.js`,
`EnvironmentFile=/opt/cctag/.env`) so it survives reboots — see
`assets/cctag-hub.service` for a template unit file — then `systemctl
enable --now caddy cctag-hub`.

Issue each person a token from the Hub, bound to their own Slack user ID —
a token can only ever register as the owner it was issued for, so a leaked
or misused token can't be used to impersonate someone else's connection
(but it can still act on that owner's own paired threads, so only hand
these to people you trust):

```bash
node dist/hub/index.js token issue <name> <ownerUserId>   # prints a token
node dist/hub/index.js token list
node dist/hub/index.js token revoke <name>
```

Send each person the printed token, the Hub's `wss://` URL, and the
`ownerUserId` you issued it for — that's everything they need for [For
Spoke users](#for-spoke-users).

### Bridging a second Slack workspace

A Hub is tied to exactly one Slack app/workspace (its `SLACK_BOT_TOKEN`/
`SLACK_APP_TOKEN`). To bridge a second workspace, run a second Hub — it
doesn't need its own machine; a second lightweight process (own port, own
`.env`, own systemd unit) on the same box is enough.

**Tokens are namespaced per Hub.** If the second Hub is started with
`CCTAG_ENV_FILE=/opt/cctag/.env.workspace2` pointing at its own `.env`
(rather than a duplicated checkout), its `token issue`/`list`/`revoke`
commands also need that same `CCTAG_ENV_FILE` prefix, or they silently
operate on the *first* Hub's token store instead:

```bash
CCTAG_ENV_FILE=/opt/cctag/.env.workspace2 node dist/hub/index.js token issue <name> <ownerUserId>
```

## For Spoke users

*(This is the section for you if someone else already runs a Hub and just
handed you a token, a Hub URL, and a Slack user ID.)*

You can't generate any of these yourself — get them from your Hub operator:

- `CCTAG_HUB_URL` — the Hub's `wss://...` address
- `CCTAG_SPOKE_TOKEN` — a token issued specifically for you
- `CCTAG_OWNER_USER_ID` — your own Slack user ID; must match the ID the
  token was issued for, or the Hub rejects the connection

Make sure herdr is installed and your Claude Code and/or Codex CLI
instance(s) are registered as herdr agents first — see [Installing
herdr](#installing-herdr-macos-notes) above.

```bash
git clone https://github.com/moiku/claude-code-tag.git
cd claude-code-tag
npm install
cp .env.example .env
$EDITOR .env   # CCTAG_HUB_URL, CCTAG_SPOKE_TOKEN, CCTAG_OWNER_USER_ID, CCTAG_HERDR_BIN
npm run build
npm run start:spoke   # or dev:spoke while iterating
```

The Spoke reconnects automatically (with backoff) if the connection drops.
Pairing state lives locally on your machine
(`~/.cctag/pairings-<hub-url>.json`, namespaced per Hub) — the Hub only
keeps a lightweight, in-memory "which thread belongs to which Spoke" map,
rebuilt from what each Spoke reports on connect.

### Connecting to more than one workspace

If your operator runs more than one Hub (e.g. two Slack workspaces), you
need one Spoke per Hub, each with its own token. Run a second Spoke from
the same checkout by pointing `CCTAG_ENV_FILE` at a per-instance `.env`
instead of duplicating the whole directory — `CCTAG_HUB_URL`,
`CCTAG_SPOKE_TOKEN`, and pairing storage are all kept separate per Hub URL
automatically:

```bash
CCTAG_ENV_FILE=/opt/cctag/.env.workspace2 node dist/spoke/index.js
```

For a persistent second instance, add a second launchd
`LaunchAgent`/systemd unit whose `EnvironmentVariables`/`Environment` sets
`CCTAG_ENV_FILE` to that second `.env` file.

Both Spokes on one machine still talk to the **same local herdr daemon**,
so they see the same pool of Claude Code/Codex CLI instances — pairing one workspace
to a terminal doesn't stop the other workspace's picker from also offering
it. cctag doesn't guard against this across separate Spoke processes (only
within one Spoke's own pairings); avoid pairing the same terminal from two
workspaces at once, or you'll get keystrokes interleaved from both.

### Troubleshooting: "invalid token"

```
[spoke] disconnected from hub (code 4001: invalid token)
```

This means the Hub you're connecting to doesn't recognize your token —
almost always because it was issued somewhere other than the exact Hub
process you're pointed at (a different machine, or, on a Hub bridging
multiple workspaces, a different workspace's token store — see [Bridging a
second Slack workspace](#bridging-a-second-slack-workspace)). Ask your
operator to double-check:

- `CCTAG_HUB_URL` in your `.env` matches the Hub they issued the token
  against
- `CCTAG_OWNER_USER_ID` exactly matches the `ownerUserId` the token was
  issued for
- `node dist/hub/index.js token list`, run on the actual Hub machine (with
  the matching `CCTAG_ENV_FILE`, if it bridges more than one workspace),
  shows your name

If it's not listed there, ask them to re-issue it.

### Troubleshooting: `protocol_mismatch` / "インスタンスが見つかりません" after a herdr update

If cctag suddenly can't reach any paired session — the Spoke log fills with

```
{"code":"protocol_mismatch","message":"client protocol N is newer than server protocol M; restart the Herdr server ..."}
```

or every Slack command replies **⚠️ インスタンスが見つかりません** — your local
herdr almost certainly auto-updated underneath a still-running herdr server.
This is a herdr-side issue, not a pairing you need to redo. Fix it in two steps:

**1. Restart the herdr server so client and server run the same version.**
The `herdr` CLI (client) is the freshly-installed binary, but the background
`herdr server` process is still the old one, so they disagree on the wire
protocol. Restarting the server exits pane processes, so save work first:

```bash
herdr server stop      # this closes running panes — expected
herdr                  # starts a fresh server on the new version
```

Then re-register your Claude Code / Codex agents (`herdr agent start ...`, see
[Installing herdr](#installing-herdr-macos-notes)) and re-run `@cctag connect`
in each thread.

**2. Update cctag if it's from before the herdr 0.7.5 change.**
herdr 0.7.5 (2026-07-21) stopped accepting a `terminal_id` as an agent-command
target — only a pane id resolves now — and removed `herdr agent send`
(`agent send-keys` only takes key *names*, not free text). cctag builds from
before this addressed agents by `terminal_id` and injected text with
`agent send`, so on herdr ≥ 0.7.5 every command fails even after a clean server
restart. Update to the current cctag, which addresses panes by `pane_id` and
injects text via `pane send-text`:

```bash
git fetch origin && git reset --hard origin/main   # NOT `git pull` — main history was rewritten once
npm install && npm run build
# then restart your Spoke (launchctl kickstart -k gui/$(id -u)/<your-spoke-label>,
# or just re-run npm run start:spoke)
```

The Hub↔Spoke wire protocol is unchanged across this fix, so a new Spoke and an
old Spoke both work against the same Hub — you can update at your own pace, and
the Hub itself does not need redeploying for this.

## Usage

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

### Sending files and images to the agent

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

### Getting files back out

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

### Switching model

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

### Switching mode

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

### Plan Mode over Slack

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

### Catching up on thread activity cctag wasn't mentioned in

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

### Work started outside of Slack

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

## Security notes

Anyone who can post in a paired thread can send arbitrary text into a
full-permission local coding agent. Pairing is owner-opt-in per thread, the
owner can disconnect at any time, and tool permission prompts still require
a human's approval via Slack buttons — nothing runs unattended. Only pair
threads in channels with people you trust.

## License

MIT — see `LICENSE`.
