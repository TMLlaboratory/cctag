# OMP TUI and transcript fixtures

The V7 screen captures were recorded on 2026-09-29 with OMP 18.3.4 and Orca CLI/app 1.4.215. Each `.screen.json` stores the raw `result.terminal` object from an unbounded read; every field and tail row is retained except values listed in that file's `capture.redactions` map. Every source reported `status: "running"`, `source: "screen"`, `limited: false`, and `truncated: false`.

| File | State shown | Source capture | Tail rows |
|---|---|---|---:|
| `idle.screen.json` | Empty composer, no modal | `design/capture/V7/1-idle-full-a.json` | 30 |
| `working.screen.json` | Active turn with spinner and elapsed time | `design/capture/V7/1-working-a.json` | 27 |
| `draft.screen.json` | Unsent non-empty composer | `design/capture/V7/1-draft-open.json` | 18 |
| `ask-open.screen.json` | Ask dialog open | `design/capture/V7/1-ask-open-a.json` | 31 |
| `ask-open-second.screen.json` | Same Ask dialog, at least 11 seconds later; visible text unchanged | `design/capture/V7/1-ask-open-b.json` | 31 |
| `ask-closed.screen.json` | Cancelled Ask dialog closed | `design/capture/V7/1-ask-closed.json` | 18 |
| `settings-open.screen.json` | `/settings` open | `design/capture/V7/1-settings-open-a.json` | 40 |
| `settings-closed.screen.json` | `/settings` closed | `design/capture/V7/1-settings-closed.json` | 18 |
| `approval.screen.json` | `Allow tool: bash` approval dialog; `Deny` is a menu row | `design/capture/V7/2-approval-prompt-a.json` | 31 |
| `resumed-session.screen.json` | Existing session resumed; composer empty | `design/capture/V7/3-resume-existing-screen.json` | 22 |
| `child-omp.screen.json` | Parent TUI showing the child `omp -p` run | `design/capture/V7/6-child-omp-screen-b.json` | 27 |
| `idle-startup.screen.json` | Empty startup composer with right-aligned footer hint | `design/capture/V7/1-idle-a.json` | 28 |
| `approval-startup.screen.json` | Empty startup composer with right-aligned footer hint (approval run) | `design/capture/V7/2-approval-start-screen.json` | 29 |
| `session-dir-startup.screen.json` | Empty startup composer with right-aligned footer hint (`--session-dir` run) | `design/capture/V7/5-session-dir-start-screen.json` | 28 |

The task-specific prompts, responses, paths, profile, choice labels, terminal handles, and usage values are neutralized by consistent placeholders. The visible Ask option count and the draft's non-empty composer state remain visible. The resumed-session process observation, including the absence of a transcript FD at idle, is in `src/backend/__fixtures__/orca/omp/resumed-tui-no-fd.json`.

`transcript-lifecycle.jsonl` is a 14-record excerpt from `design/capture/V4/C12-omp-first-session-final.jsonl` (source records 2, 9–13, and 19–26), captured 2026-09-28 with OMP 18.3.4 and Orca CLI/app 1.4.215. It preserves the session record, user messages, tool calls and results, normal `stopReason: "stop"`, `stopReason: "aborted"`, and `session_exit`; record keys and nesting are retained while content, paths, and identifiers are redacted. The `tool_execution_start` custom records are included as captured but are not turn boundaries.

Transcript placeholder classes: `<session-A>` is the session ID; `<scratch-V4-A>` is its source cwd; `<record-01>` through `<record-15>` are record IDs, including parent references to omitted records; `<tool-call-A>` through `<tool-call-F>`, `<response-A>` through `<response-D>`, and `<message-A>`/`<message-B>` are tool-call, response, and message IDs; `<opaque-id-A>` through `<opaque-id-D>` are provider metadata IDs; `<credential-A>` is a credential ID; `<choice-A>` and `<choice-B>` are Ask option labels; `<signature-A>` is a text signature; `<error-A>` is an error ID; `<task-content>` replaces private prompt, response, command, and tool content. Screen and process files list their own placeholder classes in their redactions maps.
