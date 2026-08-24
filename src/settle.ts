import type { AgentStatus } from "./herdr/types.js";
import type { TurnLifecycleEvent } from "./agents/driver.js";

/**
 * Whether the agent has finished its turn, decided from the agent's own
 * transcript rather than from herdr's `agent_status`.
 *
 * herdr's status is not a reliable "is the agent still answering?" signal. It
 * comes from prioritized detection rules evaluated against the pane, and a
 * lingering background shell trips one that outranks every idle rule: measured
 * on herdr 0.8.2 (detection manifest 2026.08.21.1), a pane whose agent was
 * plainly idle — empty prompt box, idle title glyph — reported `working`
 * indefinitely because `background_shell_working` (priority 965) beat
 * `live_prompt_box` (950) and `osc_title_idle` (250). `state_change_seq` never
 * moved. Both places that waited for `idle`/`done` therefore waited forever:
 * TurnEngine's poll loop burned its full timeout and reported one, and
 * BackgroundWatcher never posted output it had already collected.
 *
 * Deliberately NOT keyed on herdr's rule ids. Those ship in a remotely-updated
 * manifest and can be renamed or reprioritized without a herdr release, and the
 * offending rule is one of a family (background shells, background agents, MCP
 * tasks) — matching on them would be a fix with an expiry date.
 *
 * The transcript is the agent's own record of its work, so it is the thing that
 * actually knows. See the drivers' lifecycle extraction for what marks a
 * boundary in each format.
 */
export class SettleTracker {
  /**
   * `unknown` until a turn is seen to start. A completion only counts once a
   * start has been observed, which is what makes reading a stale boundary
   * harmless: TurnEngine re-resolves a transcript mid-turn and rewinds to
   * offset 0 when it does (see turn.ts's locate retry), so the records handed
   * here can begin with a *previous* turn's completion. Requiring the start
   * first means that is ignored instead of finalizing the turn that just began.
   */
  private phase: "unknown" | "running" | "finished" = "unknown";

  /**
   * Declares a turn already in progress, for a pane adopted mid-turn.
   *
   * Needed only there. A Slack-initiated turn gets a fresh tracker and its own
   * `user` record supplies the start, but adopting a blocked terminal joins a
   * turn whose start was written before the handoff's offset — so waiting for
   * one would mean the completion that eventually arrives is ignored, and an
   * adopted turn on a stuck-`working` pane would never finalize. Safe here
   * because the prompt on screen is itself proof the turn is live, and the
   * handoff's offset rules out reading a completion from an earlier turn.
   */
  markTurnRunning(): void {
    this.phase = "running";
  }

  /** Feeds boundaries from a freshly-tailed batch, in order. */
  observe(events: readonly TurnLifecycleEvent[]): void {
    for (const event of events) {
      if (event.kind === "started") this.phase = "running";
      else if (this.phase === "running") this.phase = "finished";
    }
  }

  /** Whether the transcript itself says the turn that was running has ended. */
  get settledByTranscript(): boolean {
    return this.phase === "finished";
  }

  /**
   * herdr's status, corrected only where the transcript contradicts it.
   *
   * `blocked` is returned untouched, always: a pane waiting on a permission or
   * question prompt must keep reaching the prompt-adoption path, and a prompt
   * is deliberately absent from the transcript until it has been answered — so
   * the transcript can never be evidence against a blocked pane. Everything
   * other than a `working` the transcript has already closed out is also
   * returned as-is, which keeps the failure direction safe: an agent whose
   * format grows a boundary this doesn't recognize simply behaves as it does
   * today rather than being declared finished early.
   */
  effectiveStatus(status: AgentStatus): AgentStatus {
    if (status === "blocked") return status;
    if (status === "working" && this.settledByTranscript) return "idle";
    return status;
  }
}
