# Orca process captures

Captured on 2026-09-28 with Claude Code 2.1.283 and Orca CLI/app 1.4.215.

- `claude-session-transitions.json` retains the original terminal-list, process, and session-file observations before resume, after resuming the same session, and after `/clear`. Its task workspace, branch, and scratch paths are now neutral placeholders; the redaction map covers all placeholder classes used across these fixtures.
- `worktree-ps-question-state.json` adds one live `orca worktree ps --json` `agents[]` row while AskUserQuestion is waiting, paired with the same terminal's filtered terminal-list entry and targeted process/environment row. The pane join is preserved: `agents[0].paneKey`, terminal `tabId:leafId`, and `ORCA_PANE_KEY` all use `<tab-B>:<leaf-B>`; only `ORCA_PANE_KEY` and `ORCA_TERMINAL_HANDLE` are retained from the process environment.
- `same-tty-foreground-child-policy.txt` is unchanged. Its same-process contract question remains design-owned.

The one-state sample is intentionally reduced to the selected agent row, one terminal entry (`totalCount: 1` in the reduced fixture), and the matching process row. Resume/clear transitions were not replayed; the existing transition fixture is retained and the missing `worktree ps` join is added separately.

Captured commands: `orca worktree ps --json`; `orca terminal list --worktree path:<worktree-B> --json`; `ps -p <pid> -o pid=,ppid=,pgid=,tpgid=,tty=,lstart=,command=`; and `ps eww -p <pid>` (retaining only the two Orca environment keys). The process sample maps its task-specific title as `<terminal-title>`; screen fixtures map `<prior-session-note>` and `<task-content>` for non-TUI transcript content.

## Claude composer probe captures

Captured on 2026-10-02 with Claude Code 2.1.287 and Orca CLI/app 1.4.216. Each file preserves the complete raw `orca terminal read --screen --json` envelope and every screen row; request IDs, terminal handles, and runtime IDs are redacted, as are Stop-hook lines about dotfiles.

- `p4-00-draft.json` — typed draft before the probe (`capture/V9/p4-00-draft.json`).
- `p4-01-draft-plus-x.json` — typed draft with the probe appended (`capture/V9/p4-01-draft-plus-x.json`).
- `p4-02-draft-after-bs.json` — typed draft after Backspace (`capture/V9/p4-02-draft-after-bs.json`).
- `p4-10-suggestion.json` — prompt suggestion before the probe (`capture/V9/p4-10-suggestion.json`).
- `p4-11-suggestion-plus-x.json` — suggestion replaced by the probe (`capture/V9/p4-11-suggestion-plus-x.json`).
- `p4-12-suggestion-after-bs.json` — prompt suggestion restored by Backspace (`capture/V9/p4-12-suggestion-after-bs.json`).
- `p3-10-stashed.json` — empty composer with the exact `❯ Try "…"` placeholder (`capture/V9/p3-10-stashed.json`).
- `p3-11-right-after-submit.json` — observed post-submit draft restoration (`capture/V9/p3-11-right-after-submit.json`).
- `probe-A-fresh.json` — fresh-session composer with the `❯ Try "…"` placeholder (`capture/V9/probe-A-fresh.json`).
- `probe-C-typed.json` — typed draft reported separately from the visible `❯` row (`capture/V9/probe-C-typed.json`).

Two screen reads from long-lived terminals, captured on 2026-10-02 with Orca 1.4.216, keep the raw envelope and every flag; every non-blank screen row is replaced by `<screen row>` (the rows are other sessions' content), and request IDs, terminal handles and runtime IDs are redacted.

- `screen-read-long-lived-truncated.json` — a Claude Code terminal: `truncated: true` (carried over from Orca's stream buffer), `limited: false`, 52 rows; the screen itself is whole.
- `screen-read-omp-limited-truncated.json` — an `omp` terminal: `truncated: true`, `limited: true`, 68 rows.

## Named-session composer capture

Captured on 2026-10-08 with Orca CLI 1.4.222 (app 1.4.218) and a Claude Code older than 2.1.292 (the pane showed an update notice; its exact version was not recorded), from a session renamed with `/rename` showing a prompt suggestion. The raw `orca terminal read --screen --json` envelope and every TUI row around the composer are kept; transcript rows above it are replaced by `<task-content>`, the repository name in the footer by `<repo>`, and request IDs, terminal handles and runtime IDs are redacted.

- `named-session-suggestion.json` — the rule above the prompt carries the session name (`──── design ─`). Orca returns no `draft` and leaves the suggestion in `tail` as `❯` + U+00A0 + text, where a session without a name gets the text in `draft` and a bare `❯` row.
