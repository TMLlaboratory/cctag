Setting up the Slack app and running a Hub — everything only the person
hosting cctag needs. For connecting to a Hub someone else runs, see
[spoke-setup.md](spoke-setup.md).

# Running a Hub

*(Skip this whole section if you're connecting to a Hub someone else
already runs — see [For Spoke users](../README.md#for-spoke-users) instead.)*

## Create the Slack app

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

## Running standalone

Find your own Slack user ID (three-dot menu on your profile → *Copy member
ID*) — this is `CCTAG_OWNER_USER_ID`. Only this user can run
`connect`/`disconnect`: those choose which of *this machine's* panes a thread
is attached to, and this machine is yours. Talking to a thread once it's
paired is not restricted — see [What this actually looks like in
use](../README.md#what-this-actually-looks-like-in-use).

```bash
cp .env.example .env
$EDITOR .env   # SLACK_BOT_TOKEN, SLACK_APP_TOKEN, CCTAG_OWNER_USER_ID, CCTAG_HERDR_BIN
npm install
npm run dev   # or: npm run build && npm start
```

Config is discovered in a fixed, cwd-independent order: `CCTAG_ENV_FILE` (if
set) → `~/.config/cctag/config.env` → `./.env` — the first match found is
read, and the rest are ignored. A binary-distributed install (no
checkout, e.g. `brew install cctag`) doesn't have a `.env.example` to copy,
so put its config at `~/.config/cctag/config.env` instead; if that file and
a required variable are both missing, the binary writes a starting
template there itself and tells you to fill it in. Running under systemd
with `EnvironmentFile=` (see [Running a
Hub](../README.md#running-a-hub-for-more-than-one-person) below) needs no file at all —
having zero config files present is the normal, correct state there.

`npm run typecheck` and `npm test` cover the parts that are cheap to check
without a live Slack workspace — attachment limits, the outbound-file rules,
denied-write correlation, and the download size guard. The parts that need a
real terminal (prompt submission, permission prompts) are verified by hand
against a disposable herdr pane.

## Running a Hub (for more than one person)

The Hub needs the same `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN` as standalone
mode, plus a public `wss://` endpoint (a domain + TLS in front of it —
[Caddy](https://caddyserver.com) gets you automatic HTTPS with almost no
config). A single Oracle Cloud "Always Free" `VM.Standard.E2.1.Micro`
instance is plenty. This machine does **not** need herdr, Claude Code, or
Codex CLI.

```bash
git clone https://github.com/TMLlaboratory/cctag.git /opt/cctag
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
Spoke users](../README.md#for-spoke-users).

## Bridging a second Slack workspace

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
