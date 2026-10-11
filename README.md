🌐 [日本語](README.ja.md) | **English**

---

# cctag

<img src="assets/icon.png" alt="cctag icon" width="120" />

Bridge a Slack thread to a **locally running coding-agent TUI session** —
Claude Code, Codex CLI, or oh-my-pi (`omp`) — the way
[Claude Tag](https://www.anthropic.com/news/introducing-claude-tag) bridges
Slack to a cloud session — except cctag drives *your own terminal*. Available
agent/backend combinations vary; see the support matrix below.

The diagram below shows a herdr-based setup; an Orca-based setup uses Orca for its terminal connection.

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

In a Herdr-backed setup, cctag controls the paired agent through [herdr](https://herdr.dev)
(a terminal workspace manager) rather than screen-scraping tmux — discovery,
keystroke injection, and status use Herdr. Turn output comes from the agent's
own structured JSONL transcript, not the screen. Herdr reports `claude` or
`codex`, and cctag selects the matching driver. This covers Claude Code or
Codex CLI on Herdr; see the support matrix for Orca combinations.

cctag can also drive agents running in [Orca](https://github.com/stablyai/orca)
terminals, alongside herdr, from the same Spoke. In the `@cctag connect` picker,
Orca Claude Code and `omp` rows share the `orca · <directory name>` group;
`omp` rows carry the `[omp]` prefix. Herdr pane IDs and existing pairings keep
their current format.
See [Terminal backends](#terminal-backends-herdr-and-orca).

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

**v0.5.0** — see [CHANGELOG.md](CHANGELOG.md) for what each release changed.
Pre-1.0 is a deliberate claim rather than a placeholder: the interface still
moves, so pin an exact version if that matters to you.

Text-in / text-out turns work for the supported combinations: Claude Code on
Herdr or Orca, Codex CLI on Herdr, and `omp` on Orca. For supported Claude Code
and Codex CLI tool-permission / command-approval prompts, cctag shows Slack
buttons; a human can answer through Slack or at the terminal. `omp` questions
and approvals appear in Slack as terminal-only notices; Slack answers aren't
supported.

Claude Code and Codex CLI don't write pending permission or question prompts
to their session transcripts until after they're answered, so cctag reads them
from the terminal screen through the selected backend (Herdr or Orca). OMP
uses a separate terminal-only notice path. See
`src/agents/claude/prompts.ts`, `src/agents/codex/prompts.ts`, and
`src/agents/omp/prompts.ts`.

### Agent support

The table compares Claude Code and Codex CLI; `omp`'s narrower support is
listed in the terminal-backend matrix below.

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
silently — e.g. `@cctag mode plan` on Codex or `@cctag model` on `omp`.

### Terminal backends: herdr and Orca

One Spoke can serve both backends at once. Each backend uses its configured
executable if that path exists; when a variable is unset, cctag uses its
default path (`CCTAG_HERDR_BIN`: `/opt/homebrew/bin/herdr`;
`CCTAG_ORCA_BIN`: `/opt/homebrew/bin/orca`). Set either variable to an empty
string to disable that backend. At least one backend must be available.

| | herdr | Orca |
|---|:---:|:---:|
| Claude Code | ✅ everything in the table above | ✅ everything in the table above |
| Codex CLI | ✅ | — *(not listed: Orca's shared Codex app server can attribute status to the wrong pane — [stablyai/orca#23643](https://github.com/stablyai/orca/issues/23643))* |
| oh-my-pi (`omp`) | — | ✅ Turns, output, status and `.cctag/outbox` uploads; incoming attachments are passed as paths. Prompts and approvals show “answer in the terminal” (no Slack answers, `mode`, `plan` or `model`) |

On Orca, cctag identifies the agent from its pane key, process start time and
foreground process group. For `omp`, it also verifies the transcript the
process holds open for writing. The process identity is checked again
immediately before each terminal write. A pane whose agent or session cannot
be identified is omitted rather than guessed. A resumed `omp` session without
a verifiable open transcript cannot be connected; if that leaves no
connectable agents, the empty `@cctag connect` result says to start a new
session.

Orca reports Claude Code's grayed-out next-prompt suggestion the same way as
text a person typed, so before sending a Slack message into a non-empty
composer cctag types one character to tell them apart and removes it again. A
suggestion is replaced by the message. A typed draft is stashed with Ctrl+S,
the message is sent, and Claude Code puts the draft back; this replaces any
draft stashed earlier, because Claude Code keeps only one. When cctag cannot
confirm what happened, it sends nothing and says in the thread what may be left
in the composer. This was verified with Claude Code 2.1.287; on other versions
a message may be refused while a suggestion is shown.

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
  authenticated WebSocket and drives that person's local agents through its
  enabled terminal backend(s), exactly like standalone mode. Claude Code uses
  herdr or Orca, Codex CLI uses herdr, and `omp` uses Orca.

**If someone else already runs a Hub you can join**, you only need [For Spoke
users](#for-spoke-users) below — skip straight there, none of the Slack app
setup applies to you.

## Requirements

- **Node.js 20+** — needed everywhere cctag runs (Hub, Spoke, or standalone).
- **[herdr](https://herdr.dev) and/or [Orca](https://github.com/stablyai/orca)**,
  with Claude Code running in either backend, Codex CLI in herdr, or `omp` in
  Orca. Needed only on machines that run these agent sessions (standalone and
  every Spoke). A Hub-only machine runs no agent sessions and needs neither
  backend.
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

Briefly: a Spoke needs three required configuration values (`CCTAG_OWNER_USER_ID`,
`CCTAG_HUB_URL`, and `CCTAG_SPOKE_TOKEN`) plus at least one available backend
executable (Herdr or Orca). Someone hosting a Hub also creates the Slack app and
issues credentials to Spokes. Standalone runs the Hub and Spoke in one process
on one machine.


## Security notes

Anyone who can post in a paired thread can send arbitrary text into a
full-permission local coding agent. Pairing is owner-opt-in per thread, and the
owner can disconnect at any time. For supported Claude Code and Codex CLI
prompts, a human can answer with Slack buttons or at the terminal. OMP
questions and approvals are reported in Slack with instructions to answer in
the terminal. Pair only threads in channels with people you trust.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) — how to run the checks, what a review
looks for, the parts that can only be verified against a live pane, and the
release process.

## License

MIT — see `LICENSE`.
