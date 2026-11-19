import type { BackendName } from "./types.js";

export function backendForTarget(target: string): BackendName {
  if (typeof target !== "string") return "herdr";
  if (target.startsWith("orca:")) return "orca";
  if (target.startsWith("hc:")) return "herdr-core";
  return "herdr";
}
