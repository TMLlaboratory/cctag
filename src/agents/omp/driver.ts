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
import { extractOmpLifecycle, extractOmpTurnOutput } from "./transcript.js";

export const OMP_RESUME_NOTICE = "resume した omp のセッションは接続できません。新しいセッションで起動してください";

interface Descriptor {
  pid: number | null;
  fd?: string;
  access?: string;
  type?: string;
  device?: string;
  inode?: string;
  name?: string;
}

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

const MAX_SAFE_DEVICE = BigInt(Number.MAX_SAFE_INTEGER);

// Keep stat device/inode identities as exact decimal strings; inode values may
// legitimately exceed JavaScript's safe Number range.
function decimalNumber(value: string): string | null {
  if (!/^\d+$/u.test(value)) return null;
  return BigInt(value).toString(10);
}

function parseDescriptors(output: string): Descriptor[] | null {
  const rows: Descriptor[] = [];
  let pid: number | null = null;
  let current: Descriptor | null = null;
  const push = (): boolean => {
    if (!current) return true;
    if (current.pid === null || !current.fd) return false;
    rows.push(current);
    current = null;
    return true;
  };

  for (const line of output.split(/\r?\n/u)) {
    if (!line) continue;
    const field = line[0];
    const value = line.slice(1);
    if (field === "p") {
      if (!push()) return null;
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) return null;
      pid = parsed;
    } else if (field === "f") {
      if (!push() || pid === null) return null;
      current = { pid, fd: value };
    } else if (current && field === "a") {
      current.access = value;
    } else if (current && field === "t") {
      current.type = value;
    } else if (current && field === "D") {
      if (!/^0x[0-9a-f]+$/iu.test(value)) return null;
      const device = BigInt(value);
      if (device > MAX_SAFE_DEVICE) return null;
      current.device = device.toString(10);
    } else if (current && field === "i") {
      current.inode = value;
    } else if (current && field === "n") {
      current.name = value;
    }
  }
  if (!push()) return null;
  return rows;
}

function descriptorMode(descriptor: Descriptor): string | null {
  const suffix = descriptor.fd?.match(/^\d+([rwu])?$/u)?.[1] ?? null;
  if (descriptor.access && suffix && descriptor.access !== suffix) return null;
  return descriptor.access ?? suffix;
}

function parseOpeners(output: string): Array<{ pid: number; mode: string }> | null {
  const rows: Array<{ pid: number; mode: string }> = [];
  let pid: number | null = null;
  let processHasMode = false;
  let descriptorOpen = false;
  let descriptorHasMode = false;
  const closeDescriptor = (): boolean => {
    if (descriptorOpen && !descriptorHasMode) return false;
    descriptorOpen = false;
    descriptorHasMode = false;
    return true;
  };

  for (const line of output.split(/\r?\n/u)) {
    if (!line) continue;
    const field = line[0];
    const value = line.slice(1);
    if (field === "p") {
      if (!closeDescriptor() || (pid !== null && !processHasMode)) return null;
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) return null;
      pid = parsed;
      processHasMode = false;
    } else if (field === "f") {
      if (pid === null || !closeDescriptor()) return null;
      descriptorOpen = true;
    } else if (field === "a") {
      if (pid === null || !/^[rwu]$/u.test(value)) return null;
      rows.push({ pid, mode: value });
      processHasMode = true;
      if (descriptorOpen) descriptorHasMode = true;
    } else if (field === "c" || field === "t" || field === "i" || field === "n") {
      if (pid === null) return null;
    } else {
      return null;
    }
  }
  if (!closeDescriptor() || (pid !== null && !processHasMode)) return null;
  return rows;
}

function onlyProcessWrites(output: string, ownerPid: number): boolean {
  const rows = parseOpeners(output);
  return (
    rows !== null &&
    rows.some((row) => row.pid === ownerPid && (row.mode === "w" || row.mode === "u")) &&
    rows.every((row) => row.pid === ownerPid || (row.mode !== "w" && row.mode !== "u"))
  );
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
  if (!writer.device || !writer.inode || !writer.name) return null;

  const stat = (await access.runSystem("stat", ["-f", "%d %i", writer.name])).match(
    /^\s*(\d+)\s+(\d+)\s*$/u,
  );
  if (!stat) return null;
  const statDevice = decimalNumber(stat[1]!);
  const statInode = decimalNumber(stat[2]!);
  const writerInode = decimalNumber(writer.inode);
  if (statDevice !== writer.device || statInode === null || writerInode === null || statInode !== writerInode) {
    return null;
  }

  const openers = await access.runSystem("lsof", ["-Fpa", writer.name]);
  if (!onlyProcessWrites(openers, process.pid)) return null;

  const sessionId = basename(writer.name).match(
    /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/iu,
  )?.[1];
  if (!sessionId) return null;
  const session = firstSessionRecord(await access.readTranscriptHead(writer.name));
  if (
    !session ||
    session.version !== 3 ||
    session.id !== sessionId ||
    session.cwd !== process.cwd
  ) {
    return null;
  }
  return {
    sessionId,
    transcriptIdentity: { path: writer.name, device: writer.device, inode: writer.inode },
  };
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
