import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BackendUnavailable } from "./types.js";

const execFileAsync = promisify(execFile);

export async function runHerdrRaw(bin: string, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync(bin, args, { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
    return result.stdout;
  } catch (err) {
    const error = err as { message?: string };
    throw new BackendUnavailable(error.message ?? "herdr command failed");
  }
}

export async function sendHerdrKeys(bin: string, target: string, ...keys: string[]): Promise<void> {
  await runHerdrRaw(bin, ["pane", "send-keys", target, ...keys]);
}

export async function sendHerdrText(bin: string, target: string, text: string): Promise<void> {
  await runHerdrRaw(bin, ["pane", "send-text", target, text]);
}
