# Claude Code screen captures

The eight Claude frames were captured on 2026-09-28 from the same live Claude Code session in one isolated Orca scratch terminal. Claude Code 2.1.283; Orca CLI 1.4.215; Orca app 1.4.215.

Each of those eight Claude files stores the `result.terminal` object from `orca terminal read --terminal <terminal-B> --screen --json` with the default, unbounded read. `tail` order, all returned rows, and every terminal field are preserved; only the redactions listed in each `capture.redactions` map alter values. All eight report `source: "screen"`, `limited: false`, and `truncated: false`. The additional `shell-prompt.screen.json` is a redacted excerpt from `design/capture/V3-codex-after-quit-shell-screen.json`; its captured `truncated: true` flag is preserved.

The four multi-select frames were captured on 2026-09-29 from a live Claude Code 2.1.283 session in a registered-worktree Orca terminal. Each stores the raw `result.terminal` object from a default unbounded screen read with every returned row preserved; only the listed redactions alter values. Orca CLI and app versions were not recorded.

- `idle-composer.screen.json` — blank composer after cancelling `/model` (68 returned rows).
- `working.screen.json` — active screen while the prompt-submission hook was running, with the observed `✳ Ionizing… (running UserPromptSubmit hooks… 1/2 · 0s)` status (65 returned rows). This exact in-progress status is retained; no `esc to interrupt` row appeared in this frame.
- `ask-user-question-before-down.screen.json` and `ask-user-question-after-down.screen.json` — the single-select question before and after one Down (69 rows each; cursor moves from amber to cobalt).
- `ask-user-question-cancelled.screen.json` — Escape cancellation (`User declined to answer questions`); the complete screen returns to an empty composer (69 rows).
- `model-menu-before-down.screen.json` and `model-menu-after-down.screen.json` — `/model` before and after one Down (69 rows each; cursor moves from the recommended default row to the Opus 5.5 row).
- `model-menu-cancelled.screen.json` — Escape result; Opus 5.5 remains the default and the complete screen returns to an empty composer (68 rows).
- `ask-user-question-multiselect-before-down.screen.json` — multi-select prompt with the cursor on option 1 (19 returned rows).
- `ask-user-question-multiselect-submit-row.screen.json` — Amber and Jade selected; cursor on the unnumbered Submit row after four Down keys (19 rows).
- `ask-user-question-multiselect-review.screen.json` — Enter on Submit displays the actual review screen with `Amber, Jade`, `1. Submit answers`, and `2. Cancel` (13 rows).
- `ask-user-question-multiselect-cancelled.screen.json` — selected the visible `2. Cancel` row without sending `1`; Claude reports `User declined to answer questions` (16 rows).
- `idle-composer-named-session.screen.json` — blank composer after `/rename design`, captured on 2026-10-07 from a live Claude Code 2.1.291 session (Orca CLI 1.4.218). The session name sits in the rule above the prompt; the rule below stays plain. An excerpt: the rows above the finished turn were private work content and were dropped, and the recap and status-line values are redacted as listed in its `capture.redactions`. The read itself returned 33 rows with `truncated: false` and `limited: false`.
- `shell-prompt.screen.json` — redacted shell tail from the Codex-after-quit capture; incomplete source screen, not a Claude composer.

Existing transcript fixture:
- `claude-interrupt.jsonl` — a four-record transcript where the final user-interruption record marks the turn as aborted rather than started.
- `claude-compact.jsonl` and `claude-model.jsonl` — the records `/compact` (Claude Code 2.1.287) and `/model` (2.1.285) write, ending on `<local-command-stdout>` with no assistant reply. Record order, `type` / `subtype` / `isMeta` / `isCompactSummary` / `isSidechain` / `version` and `message.role` are copied from real interactive transcripts (2026-10-02); all text is replaced by placeholders except each string's leading tag and the first words of the stdout. Timestamps are normalized.

`<plan>` replaces the account-tier label; `<scratch>` replaces the scratch path/status; `<prior-session-note>` masks the earlier-session notification and recap; `<task-content>` masks non-TUI task prose while preserving its rows; usage values are `<redacted>`. Japanese question/option labels remain as visible TUI content. Terminal/worktree identifiers and the task-specific workspace/branch use the placeholders described by the shared redaction map; `<terminal-C>` replaces this task's registered-worktree terminal handle. No screen rows in the twelve complete Claude captures were curated or trimmed; the shell fixture is a redacted excerpt.

Side-pane frames, captured on 2026-10-09 from a live Claude Code 2.1.292 session in an Orca terminal (Orca CLI 1.4.222) with the qa-guide 0.4.0 mod installed. Each stores the `result.terminal` object from a default unbounded `--screen --json` read, 84 rows, `limited: false`, `truncated: false`. Redactions are padded with spaces to the original display width, so the divider column stays where the terminal drew it.

- `side-pane-question.screen.json` — single-select question with the mod pane open to its right; every row carries the pane after a `│` at display column 128.
- `side-pane-after-answer.screen.json` — the same session after answering option 1; the pane stays open beside the transcript, and the composer and footer are drawn full-width below it.
- `side-pane-question-herdr.screen.json` — the same kind of question on herdr 0.9.3 (120-column pane, pane opened with `/qa-guide`). Not an Orca read: it stores the raw stdout of `herdr pane read <pane> --source recent --lines 200` as `text`, 40 rows. The divider sits at display column 70 and the question row runs flush against it.
