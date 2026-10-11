# OMP process and terminal captures

V4 process/transcript observations were captured 2026-09-28; V7 screen and process observations were captured 2026-09-29. Both sets used OMP 18.3.4 and Orca CLI/app 1.4.215. JSON samples retain source field structure where available; redacted values are listed in each file's `redactions` map. Home paths use `/Users/user`.

| File | Evidence |
|---|---|
| `new-session-writer.json` | V4 C12 process/environment, transcript metadata, selected `lsof` rows, and terminal-show object. The TUI owns the JSONL as FD `37w`, type `REG`; the redacted device/inode tokens agree between the descriptor and transcript metadata. |
| `resumed-tui-no-fd.json` | V7 resumed OMP process at idle, matching transcript `lsof` output empty, no session JSONL row in the process `lsof` capture, and the terminal-show object. |
| `single-opener-lsof.json` | V7 `lsof <transcript>` output with exactly one OMP writer, FD `35w`, type `REG`, plus the structured FD capture. |
| `session-dir-writer.json` | V7 explicit `--session-dir` run. The process cwd is the supplied directory and the transcript is its direct child, held at FD `38w`; the terminal-show object is included. |
| `child-omp-process-shape.json` | V7 child command/help/report observation: `omp -p --no-session --no-tools` returned exit status 0 in 5.59 seconds. This is not a raw process snapshot: `childProcessSnapshot` is `null` because no child `ps`/`lsof`/TTY row was retained. |

The inspected V4/V7 sources did not retain an OMP `orca terminal list` response or `stat` output. No synthetic terminal-list or stat capture is presented as observed data; tests must synthesize those inputs. The child fixture likewise records the observed command/result but not a raw PID/PPID/TTY snapshot. `MAPPING.md` lists these gaps and the additional synthetic inputs required by §13.7.
