import { execFile } from "node:child_process";
import { open } from "node:fs/promises";
import { promisify } from "node:util";
import type { OrcaExecResult } from "./orca.js";
import { BackendUnavailable } from "./types.js";

const execFileAsync = promisify(execFile);

// Not every lsof exit 1: a bad option exits 1 too, and differs only in
// explaining itself on stderr (measured on macOS).
function lsofFoundOnlySome(file: string, result: OrcaExecResult): boolean {
  return file === "lsof" && result.exitCode === 1 && !result.stderr.trim();
}

export function resultError(result: OrcaExecResult): string {
  return result.stderr.trim() || result.error || `command exited with status ${result.exitCode}`;
}

export function lstartTimestamp(value: string): number | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export async function nativeExecFile(file: string, args: string[], options: { timeoutMs: number }): Promise<OrcaExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      timeout: options.timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown; message?: string };
    return {
      stdout: typeof failure.stdout === "string" ? failure.stdout : "",
      stderr: typeof failure.stderr === "string" ? failure.stderr : "",
      // Not 1: a timed-out lsof would then pass for one that found part of its list.
      exitCode: typeof failure.code === "number" ? failure.code : -1,
      error: failure.message,
    };
  }
}
const MAX_SESSION_HEAD_BYTES = 64 * 1024;
const MAX_SESSION_HEAD_LINES = 16;

export async function nativeReadTranscriptHead(path: string): Promise<string> {
  const file = await open(path, "r");
  const chunks: Buffer[] = [];
  let bytes = 0;
  let lines = 0;
  try {
    while (bytes < MAX_SESSION_HEAD_BYTES) {
      const buffer = Buffer.allocUnsafe(Math.min(4096, MAX_SESSION_HEAD_BYTES - bytes));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, bytes);
      if (bytesRead === 0) break;
      let length = bytesRead;
      for (let index = 0; index < bytesRead; index++) {
        if (buffer[index] === 0x0a && ++lines === MAX_SESSION_HEAD_LINES) {
          length = index + 1;
          break;
        }
      }
      chunks.push(buffer.subarray(0, length));
      bytes += length;
      if (lines === MAX_SESSION_HEAD_LINES) break;
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await file.close();
  }
}

export async function runSystem(
  run: typeof nativeExecFile, file: string, args: string[], timeoutMs = 5_000,
): Promise<string> {
  let result: OrcaExecResult;
  try {
    result = await run(file, args, { timeoutMs });
  } catch (error) {
    throw new BackendUnavailable(error instanceof Error ? error.message : String(error));
  }
  if (result.exitCode !== 0 && !lsofFoundOnlySome(file, result)) {
    throw new BackendUnavailable(resultError(result));
  }
  return result.stdout;
}
