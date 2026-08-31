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
   ├─ inject:  herdr agent prompt   <pane_id> <text>   (text + Enter, one call)
   ├─ detect:  herdr agent get      <pane_id>  (idle / working / blocked / done)
   │           + the transcript's own turn boundary, which is what actually
   │             decides a turn is over — see src/settle.ts for why
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

### Attaching to a session you already started

cctag pairs a thread to an agent session that is **already running** — one you
started in your terminal and have been working in. Everything already loaded
stays loaded: the files, the working tree, the context built up over hours.
Comparable tools start a new session per mention instead, which is a different
and often better-behaved thing to do.

Whether that distinction matters to you, and how cctag compares to
[Claude Tag](https://www.anthropic.com/news/introducing-claude-tag), Slack Code
and [Buzz](https://github.com/block/buzz) — including where those are the
better choice — is set out in
[docs/comparison.md](docs/comparison.md).

## Status

**v0.3.0** — see [CHANGELOG.md](CHANGELOG.md) for what each release changed.
Pre-1.0 is a deliberate claim rather than a placeholder: the interface still
moves, so pin an exact version if that matters to you.

Text-in / text-out turns work end-to-end for both **Claude Code**
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

For a fuller walkthrough of the mechanism — Hub/Spoke roles, how herdr's
agent registry differs from raw pane access, why a turn ending is decided
from the transcript, the AskUserQuestion detection quirk, how attachments are
authorized — see [docs/how-it-works.md](docs/how-it-works.md).

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

**If someone else already runs a Hub you can join**, you only need [For Spoke
users](#for-spoke-users) below — skip straight there, none of the Slack app
setup applies to you.

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

Every entry point (`cctag`, `cctag-hub`, `cctag-spoke`) prints its version
and exits with `--version`/`-v`. Tagged releases (`v*`) publish standalone
binaries for macOS and Linux (arm64/x64) via `.github/workflows/release.yml`,
built with `bun build --compile` — no Node.js install required to run one
of those binaries, only to build from source as described below.

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

## Setting it up

Which document you need depends on which side you are on.

| You are | Read |
|---|---|
| Joining a Hub someone else runs | [docs/spoke-setup.md](docs/spoke-setup.md) |
| Hosting the Hub (or running standalone) | [docs/running-a-hub.md](docs/running-a-hub.md) |
| Already paired, want to know what you can do | [docs/usage.md](docs/usage.md) |

Briefly: a Spoke user needs herdr, a token from whoever runs the Hub, and four
values in a config file. Someone hosting a Hub additionally creates the Slack
app and issues those tokens. Standalone is the Hub and the Spoke in one process
on one machine.


## Security notes

Anyone who can post in a paired thread can send arbitrary text into a
full-permission local coding agent. Pairing is owner-opt-in per thread, the
owner can disconnect at any time, and tool permission prompts still require
a human's approval via Slack buttons — nothing runs unattended. Only pair
threads in channels with people you trust.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) — how to run the checks, what a review
looks for, the parts that can only be verified against a live pane, and the
release process.

## License

MIT — see `LICENSE`.
