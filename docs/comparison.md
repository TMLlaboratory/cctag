This document is about where cctag sits relative to other tools. For how it
works, see [how-it-works.md](how-it-works.md).

# Why cctag, when these already exist

**cctag's value is not that the idea is new.** Tools that bridge a chat thread
to a coding agent exist, several predate cctag, and at least one has on the
order of thirty thousand stars against this project's handful. If you are
choosing between them, the honest starting point is that the shape is common
and the differences are narrow.

One of those differences happens to matter a lot for some people and not at all
for others, and it is worth being precise about which you are.

## The one requirement that separates them

**cctag attaches to a session that is already running.** You start `claude` (or
`codex`) in your terminal, work in it for however long, and *then* pair a thread
to that session — with everything already loaded: the files you opened, the
half-finished working tree, the context accumulated over hours.

Every comparable tool surveyed instead **starts a new session per mention.**
Some reuse an idle session per channel, but that is a managed session the tool
owns and can discard, not the one you have been working in.

| | Official chat integrations | Other third-party bridges | cctag |
|---|---|---|---|
| Runs on | Ephemeral cloud sandbox | Your machine | Your machine |
| Session | New per invocation | New per invocation | **Attaches to an existing pane** |
| Accumulated context | None (partly recoverable via a repo) | None | **Used as it stands** |
| More than one person driving one session | — | — | **Anyone in the thread** |
| Agents | Vendor's own | Varies | Claude Code and Codex CLI |
| Externally-shared channels | **Does not work** | Varies | **Works** |

## Buzz: closest in spirit, opposite on exactly this point

[block/buzz](https://github.com/block/buzz) is the nearest thing to cctag in
motivation — its own tagline is *"A workspace where humans and agents build
together, on a relay you own"*, and it supports Claude Code and Codex through
one adapter, much as cctag does through its driver abstraction. If you are
deciding between the two, read Buzz's own vision document, because it states
the disagreement outright:

> **The body's state is mortal.** Files, checkouts, half-finished working trees
> — **gone with the body** unless the substrate persists them.

**What cctag exists to reach, Buzz deliberately treats as disposable.** For
Buzz the things worth persisting are keys, history and relationships — held on
a relay — not local working state. That is a coherent position, and for a team
that wants agents to be replaceable and auditable it is arguably the better
one. It is simply the opposite answer to the same question.

Buzz also asks an organization to move to a new workspace; cctag stays inside
the Slack you already have. Which of those is cheaper depends entirely on
whether the people you need in the room are already somewhere.

## The externally-shared-channel constraint

This is the sharpest line in the table, because it is not a matter of degree.
Anthropic's own documentation says of Claude in Slack:

> Claude doesn't operate in Slack Connect channels, the ones shared with
> another company. It's off in those channels regardless of scope or bundle,
> and this isn't configurable.

As a measure against leaking information across organizational boundaries this
is entirely reasonable. But it means that **co-driving one agent session with a
collaborator at another organization cannot be done with the official
integration at all** — not with different settings, not with a different plan.
For cross-organization work in a channel that already exists, that is the whole
question.

(Quoted as documented in 2026-08. Check the current documentation before
relying on it either way.)

## This is probably a design choice, not an oversight

Four independent organizations have built something that puts an agent in a
shared, multi-person venue. **None of them attach to an existing local
session**, and Buzz says in as many words that it never will.

A plausible reason: a local session someone has been working in for hours is
hard to verify, hard to sandbox, and impossible to reproduce. For a platform
serving many people across many vendors, "a fresh session we can reason about"
is the defensible choice. cctag can make the other choice because it does not
carry that obligation — one machine, one owner, and people who visit.

This is a hypothesis about their reasoning, not a claim about their intent.

## So: is cctag the right tool for you?

**Probably yes, if** the work lives on your own machine and can't easily be
moved — local datasets, GPUs, an internal network, a model endpoint that only
resolves from inside; and you want other people to see and steer that work in a
channel that already exists, possibly with people outside your organization.

**Probably no, if** you want agents that anyone can start from chat without
somebody's laptop being on; or your organization needs central audit and
sandboxing more than it needs reach into a running session; or the people you
need are willing to move to a purpose-built workspace. Those are real
requirements, and the tools above serve them better than this one does.

cctag is one machine with one owner, that other people can visit. Every
difference in the table follows from that, including the limitations — see
[how-it-works.md](how-it-works.md) for what that costs and how it is enforced.
