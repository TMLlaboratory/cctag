import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AnswerChannel, Terminals } from "../../backend/index.js";
import type { AgentInfo, ScreenSnapshot } from "../../backend/types.js";
import type {
  AgentDriver,
  BlockedPrompt,
  ModelCommandResult,
  OrcaProcessAccess,
  OrcaProcessIdentity,
  OrcaProcessSession,
} from "../driver.js";
import { isOmpIdleComposer } from "./prompts.js";
import { descriptorMode, parseDescriptors, soleWriterIdentity, type Descriptor } from "../transcript-writer.js";
import { extractOmpLifecycle, extractOmpTurnOutput } from "./transcript.js";

export const OMP_RESUME_NOTICE = "resume した omp のセッションは接続できません。新しいセッションで起動してください";

interface OptionValue {
  present: boolean;
  value: string | null;
}
interface SessionDirectory {
  path: string;
  directChildrenOnly: boolean;
}


function commandArgs(command: string): string[] | null {
  const args: string[] = [];
  let value = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let started = false;

  for (const character of command) {
    if (escaped) {
      value += character;
      escaped = false;
      started = true;
    } else if (quote !== null) {
      if (character === quote) quote = null;
      else if (character === "\\" && quote === '"') escaped = true;
      else value += character;
      started = true;
    } else if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (character === "\\") {
      escaped = true;
      started = true;
    } else if (/\s/u.test(character)) {
      if (started) {
        args.push(value);
        value = "";
        started = false;
      }
    } else {
      value += character;
      started = true;
    }
  }
  if (quote !== null || escaped) return null;
  if (started) args.push(value);
  return args;
}

function optionValue(args: readonly string[], name: string): OptionValue {
  let value: string | null = null;
  let matches = 0;
  for (let index = 1; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === name) {
      matches++;
      value = args[index + 1] ?? null;
      if (value === null || value.startsWith("--")) return { present: true, value: null };
      index++;
    } else if (arg.startsWith(`${name}=`)) {
      matches++;
      value = arg.slice(name.length + 1) || null;
    }
    if (matches > 1) return { present: true, value: null };
  }
  return { present: matches > 0, value };
}

function sessionDirectory(process: OrcaProcessIdentity, access: OrcaProcessAccess): SessionDirectory | null {
  if (process.piCodingAgentDirSet || !process.cwd) return null;
  const args = commandArgs(process.command);
  if (!args || basename(args[0] ?? "") !== "omp") return null;

  const explicit = optionValue(args, "--session-dir");
  if (explicit.present) {
    if (!explicit.value) return null;
    return {
      path: isAbsolute(explicit.value) ? resolve(explicit.value) : resolve(process.cwd, explicit.value),
      directChildrenOnly: true,
    };
  }

  const profile = optionValue(args, "--profile");
  if (
    !profile.present ||
    !profile.value ||
    profile.value === "." ||
    profile.value === ".." ||
    /[/\\]/u.test(profile.value)
  ) {
    return null;
  }
  return {
    path: resolve(join(access.homeDir, ".omp", "profiles", profile.value, "agent", "sessions")),
    directChildrenOnly: false,
  };
}

function isUnderDirectory(directory: string, path: string): boolean {
  const child = relative(resolve(directory), resolve(path));
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function firstSessionRecord(head: string): Record<string, unknown> | null {
  const lines = head.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    if (!line) return null;
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      return null;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (typeof record.type !== "string" || !record.type) return null;
    if (record.type === "session") return record;
  }
  return null;
}


async function ompSession(
  process: OrcaProcessIdentity,
  access: OrcaProcessAccess,
): Promise<OrcaProcessSession | null> {
  const directory = sessionDirectory(process, access);
  if (!directory || !process.cwd) return null;

  const descriptors = parseDescriptors(
    await access.runSystem("lsof", ["-a", "-p", String(process.pid), "-FftpaDin"]),
  );
  if (!descriptors) return null;
  const writers: Descriptor[] = [];
  for (const descriptor of descriptors) {
    if (descriptor.pid !== process.pid || !descriptor.name) continue;
    const inDirectory = directory.directChildrenOnly
      ? dirname(resolve(descriptor.name)) === directory.path
      : isUnderDirectory(directory.path, descriptor.name);
    if (!descriptor.name.toLowerCase().endsWith(".jsonl") || !inDirectory) continue;
    const mode = descriptorMode(descriptor);
    if (descriptor.type !== "REG" || !mode) return null;
    if (mode === "w" || mode === "u") writers.push(descriptor);
    else if (mode !== "r") return null;
  }
  if (writers.length !== 1) return null;
  const writer = writers[0]!;
  const identity = await soleWriterIdentity(writer, process.pid, access);
  if (!identity) return null;

  const sessionId = basename(identity.path).match(
    /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/iu,
  )?.[1];
  if (!sessionId) return null;
  const session = firstSessionRecord(await access.readTranscriptHead(identity.path));
  if (
    !session ||
    session.version !== 3 ||
    session.id !== sessionId ||
    session.cwd !== process.cwd
  ) {
    return null;
  }
  return { sessionId, transcriptIdentity: identity };
}

export const ompDriver: AgentDriver = {
  kind: "omp",
  displayName: "omp",
  readRegion: "screen",
  orcaProcess: {
    listable: true,
    sessionUnavailableNotice: OMP_RESUME_NOTICE,
    matchesCommand(command) {
      const args = commandArgs(command);
      return args !== null && basename(args[0] ?? "") === "omp";
    },
    async session(process, access) {
      try {
        return await ompSession(process, access);
      } catch {
        return null;
      }
    },
  },

  // OMP's transcript path is carried only with its verified process binding.
  locateTranscript(_cwd: string, _sessionId: string | null): null {
    return null;
  },

  extractTurnOutput(records) {
    return { ...extractOmpTurnOutput(records), lifecycle: extractOmpLifecycle(records) };
  },
  extractLifecycle(records) {
    return extractOmpLifecycle(records);
  },

  parseBlockedPane(_paneText): BlockedPrompt {
    return { kind: "unreadable-question" };
  },
  parseCursorLabel(_snapshot: ScreenSnapshot): null {
    return null;
  },
  isIdleComposer(snapshot) {
    return isOmpIdleComposer(snapshot);
  },

  async answerOption(_channel: AnswerChannel, _value: string, _expectedLabel: string): Promise<void> {
    throw new Error("OMP prompts must be answered in the terminal");
  },

  modes: null,

  async runModelCommand(_terminals: Terminals, _agent: AgentInfo, _argsText: string): Promise<ModelCommandResult> {
    return { reply: "omp では使えません", submitOutcome: null };
  },
};
