Connecting your own machine to a Hub someone else already runs. If you are
setting up that Hub, see [running-a-hub.md](running-a-hub.md) instead.

# Spoke setup

*(This is the section for you if someone else already runs a Hub and just
handed you a token, a Hub URL, and a Slack user ID.)*

You can't generate any of these yourself — get them from your Hub operator:

- `CCTAG_HUB_URL` — the Hub's `wss://...` address
- `CCTAG_SPOKE_TOKEN` — a token issued specifically for you
- `CCTAG_OWNER_USER_ID` — your own Slack user ID; must match the ID the
  token was issued for, or the Hub rejects the connection

Make sure herdr is installed and your Claude Code and/or Codex CLI
instance(s) are registered as herdr agents first — see [Installing
herdr](../README.md#installing-herdr-macos-notes) above.

```bash
git clone https://github.com/TMLlaboratory/cctag.git
cd cctag
npm install
cp .env.example .env
$EDITOR .env   # CCTAG_HUB_URL, CCTAG_SPOKE_TOKEN, CCTAG_OWNER_USER_ID, CCTAG_HERDR_BIN
npm run build
npm run start:spoke   # or dev:spoke while iterating
```

Running from a binary install instead of this checkout? Put the same
values at `~/.config/cctag/config.env` (see the config-discovery note under
[Running standalone](../README.md#running-standalone) above) rather than `./.env` —
that path is found from any working directory, so `cctag-spoke` behaves the
same no matter where you launch it from.

The Spoke reconnects automatically (with backoff) if the connection drops.
Pairing state lives locally on your machine
(`~/.cctag/pairings-<hub-url>.json`, namespaced per Hub) — the Hub only
keeps a lightweight, in-memory "which thread belongs to which Spoke" map,
rebuilt from what each Spoke reports on connect.

## Connecting to more than one workspace

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

## Troubleshooting: "invalid token"

```
[spoke] disconnected from hub (code 4001: invalid token)
```

This means the Hub you're connecting to doesn't recognize your token —
almost always because it was issued somewhere other than the exact Hub
process you're pointed at (a different machine, or, on a Hub bridging
multiple workspaces, a different workspace's token store — see [Bridging a
second Slack workspace](../README.md#bridging-a-second-slack-workspace)). Ask your
operator to double-check:

- `CCTAG_HUB_URL` in your `.env` matches the Hub they issued the token
  against
- `CCTAG_OWNER_USER_ID` exactly matches the `ownerUserId` the token was
  issued for
- `node dist/hub/index.js token list`, run on the actual Hub machine (with
  the matching `CCTAG_ENV_FILE`, if it bridges more than one workspace),
  shows your name

If it's not listed there, ask them to re-issue it.

## Troubleshooting: `protocol_mismatch` / "インスタンスが見つかりません" after a herdr update

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
[Installing herdr](../README.md#installing-herdr-macos-notes)) and re-run `@cctag connect`
in each thread.

**2. Update cctag if it's from before the herdr 0.7.5 change.**
herdr 0.7.5 (2026-07-21) stopped accepting a `terminal_id` as an agent-command
target — only a pane id resolves now — and removed `herdr agent send`
(`agent send-keys` only takes key *names*, not free text). cctag builds from
before this addressed agents by `terminal_id` and injected text with
`agent send`, so on herdr ≥ 0.7.5 every command fails even after a clean server
restart. Update to the current cctag, which addresses panes by `pane_id` and
submits text with `agent prompt`:

```bash
git fetch origin && git reset --hard origin/main   # NOT `git pull` — main history was rewritten once
npm install && npm run build
# then restart your Spoke (launchctl kickstart -k gui/$(id -u)/<your-spoke-label>,
# or just re-run npm run start:spoke)
```

The Hub↔Spoke wire protocol is unchanged across this fix, so a new Spoke and an
old Spoke both work against the same Hub — you can update at your own pace, and
the Hub itself does not need redeploying for this.
