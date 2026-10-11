import type { BackendName } from "./types.js";

export function backendForTarget(target: string): BackendName {
  return typeof target === "string" && target.startsWith("orca:") ? "orca" : "herdr";
}
