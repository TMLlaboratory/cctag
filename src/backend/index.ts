import type { BlindPermissionPrompt, VerifiedModelMenuPrompt, VerifiedPrompt } from "./prompt.js";
import type { AgentDriver } from "../agents/driver.js";
import { BackendUnavailable, type AgentInfo, type AgentRef, type ListResult, type ScreenSnapshot, UnknownTarget } from "./types.js";
import { backendForTarget } from "./target.js";

export * from "./types.js";

export interface SubmitOutcome {
  status: "started" | "accepted";
  draftStashed: boolean;
}

export interface SubmitContext {
  driver: AgentDriver;
  cancelled(): boolean;
  transcriptGrew(): boolean | null;
  /** Herdr's existing image-upload retry budget; ordinary prompts use one poll. */
  retryLimit: number;
  /** The poll interval already used by TurnEngine before moving submit here. */
  pollIntervalMs: number;
}

export interface AnswerChannel {
  digit(n: number, terminal?: boolean): Promise<void>;
  text(value: string): Promise<void>;
  move(direction: "Up" | "Down", count: number): Promise<void>;
  confirm(expectedLabel: string, terminal?: boolean): Promise<void>;
  /** Close after the driver has observed that its final write completed the answer. */
  complete(): void;
}

/** The `/model` menu channel; Escape is not exposed on ordinary answers. */
export interface ModelAnswerChannel extends AnswerChannel {
  escape(): Promise<void>;
}

export interface BlindChannel {
  answer(choice: "y" | "n"): Promise<void>;
}

export interface ComposerChannel {
  backTab(): Promise<void>;
}

export interface Terminals {
  list(): Promise<ListResult>;
  get(target: string): Promise<AgentInfo | null>;
  exists(target: string): Promise<boolean>;
  read(target: string, lines: number, region: "screen" | "history"): Promise<ScreenSnapshot>;
  submit(ref: AgentRef, text: string, ctx: SubmitContext): Promise<SubmitOutcome>;
  openAnswer(ref: AgentRef, prompt: VerifiedPrompt): AnswerChannel;
  openModelAnswer(ref: AgentRef, prompt: VerifiedModelMenuPrompt): ModelAnswerChannel;
  openBlind(ref: AgentRef, prompt: BlindPermissionPrompt): BlindChannel;
  openComposer(ref: AgentRef, driver: AgentDriver): ComposerChannel;
}

export interface TerminalBackends {
  herdr: Terminals | null;
  orca: Terminals | null;
}

function collisionMessage(agent: AgentInfo): string {
  return `herdr target collision: reserved orca: namespace returned as ${agent.ref.target}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Routes explicit `orca:` targets and combines the enabled backends' lists. */
export function createTerminals(backends: TerminalBackends): Terminals {
  const enabled = (Object.entries(backends) as Array<["herdr" | "orca", Terminals | null]>).filter(
    (entry): entry is ["herdr" | "orca", Terminals] => entry[1] !== null,
  );
  if (enabled.length === 0) throw new BackendUnavailable("No terminal backend is enabled");

  const backendFor = (target: string): Terminals => {
    const name = backendForTarget(target);
    const backend = backends[name];
    if (!backend) throw new UnknownTarget(`No ${name} backend is enabled for target ${target}`);
    return backend;
  };

  return {
    async list(): Promise<ListResult> {
      const agents: AgentInfo[] = [];
      const failures: ListResult["failures"] = [];
      const notices: string[] = [];
      let complete = true;
      const results = await Promise.all(
        enabled.map(async ([name, backend]) => {
          try {
            return { name, ok: true as const, result: await backend.list() };
          } catch (error) {
            return { name, ok: false as const, error };
          }
        }),
      );
      for (const item of results) {
        if (!item.ok) {
          failures.push({ backend: item.name, reason: errorMessage(item.error) });
          complete = false;
          continue;
        }
        const collision = item.name === "herdr" ? item.result.agents.find((agent) => backendForTarget(agent.ref.target) === "orca") : null;
        agents.push(
          ...item.result.agents.filter((agent) => item.name !== "herdr" || backendForTarget(agent.ref.target) !== "orca"),
        );
        failures.push(...item.result.failures);
        notices.push(...item.result.notices);
        complete = complete && item.result.complete;
        if (collision) {
          failures.push({ backend: "herdr", reason: collisionMessage(collision) });
          complete = false;
        }
      }
      return { agents, failures, complete, notices };
    },
    async get(target: string): Promise<AgentInfo | null> {
      const agent = await backendFor(target).get(target);
      if (backendForTarget(target) !== "orca" && agent && backendForTarget(agent.ref.target) === "orca") {
        throw new BackendUnavailable(collisionMessage(agent));
      }
      return agent;
    },
    exists(target: string): Promise<boolean> {
      return backendFor(target).exists(target);
    },
    read(target: string, lines: number, region: "screen" | "history"): Promise<ScreenSnapshot> {
      return backendFor(target).read(target, lines, region);
    },
    submit(ref: AgentRef, text: string, ctx: SubmitContext): Promise<SubmitOutcome> {
      return backendFor(ref.target).submit(ref, text, ctx);
    },
    openAnswer(ref: AgentRef, prompt: VerifiedPrompt) {
      return backendFor(ref.target).openAnswer(ref, prompt);
    },
    openModelAnswer(ref: AgentRef, prompt: VerifiedModelMenuPrompt) {
      return backendFor(ref.target).openModelAnswer(ref, prompt);
    },
    openBlind(ref: AgentRef, prompt: BlindPermissionPrompt) {
      return backendFor(ref.target).openBlind(ref, prompt);
    },
    openComposer(ref: AgentRef, driver: AgentDriver) {
      return backendFor(ref.target).openComposer(ref, driver);
    },
  };
}
