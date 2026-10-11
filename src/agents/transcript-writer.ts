import type { OrcaProcessAccess } from "./driver.js";
import type { TranscriptIdentity } from "../backend/types.js";

// The lsof/stat parsing that ties an agent process to the one transcript it writes.
// Shared by the OMP and Codex drivers on Orca, where the process is the only witness.

export interface Descriptor {
  pid: number | null;
  fd?: string;
  access?: string;
  type?: string;
  device?: string;
  inode?: string;
  name?: string;
}

const MAX_SAFE_DEVICE = BigInt(Number.MAX_SAFE_INTEGER);

// Keep stat device/inode identities as exact decimal strings; inode values may
// legitimately exceed JavaScript's safe Number range.
export function decimalNumber(value: string): string | null {
  if (!/^\d+$/u.test(value)) return null;
  return BigInt(value).toString(10);
}

export function parseDescriptors(output: string): Descriptor[] | null {
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

export function descriptorMode(descriptor: Descriptor): string | null {
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

export function onlyProcessWrites(output: string, ownerPid: number): boolean {
  const rows = parseOpeners(output);
  return (
    rows !== null &&
    rows.some((row) => row.pid === ownerPid && (row.mode === "w" || row.mode === "u")) &&
    rows.every((row) => row.pid === ownerPid || (row.mode !== "w" && row.mode !== "u"))
  );
}

/** The writer's identity once stat agrees with lsof on the file and `pid` is its only writer. */
export async function soleWriterIdentity(
  writer: Descriptor,
  pid: number,
  access: OrcaProcessAccess,
): Promise<TranscriptIdentity | null> {
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
  if (!onlyProcessWrites(openers, pid)) return null;
  return { path: writer.name, device: writer.device, inode: writer.inode };
}
