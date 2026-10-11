import type { AgentDriver } from "../agents/driver.js";

const verifiedPromptBrand: unique symbol = Symbol("VerifiedPrompt");
const verifiedModelMenuPromptBrand: unique symbol = Symbol("VerifiedModelMenuPrompt");
const blindPermissionPromptBrand: unique symbol = Symbol("BlindPermissionPrompt");

export type VerifiedPrompt = {
  readonly [verifiedPromptBrand]: true;
  readonly fingerprint: string;
  readonly driver: AgentDriver;
  readonly form: "digit-confirms" | "digit-then-enter" | "compound";
  readonly expectedCursorLabel?: string;
  readonly expiresAt?: number;
  readonly expiredUserMessage?: string;
};

export type VerifiedModelMenuPrompt = VerifiedPrompt & {
  readonly [verifiedModelMenuPromptBrand]: true;
  readonly capability: "codex-model-menu";
};

export type BlindPermissionPrompt = {
  readonly [blindPermissionPromptBrand]: true;
  readonly driver: AgentDriver;
  readonly form: "key-confirms" | "key-then-enter";
};

export function createVerifiedPrompt(
  fingerprint: string,
  driver: AgentDriver,
  form: VerifiedPrompt["form"],
  options: {
    expectedCursorLabel?: string;
    expiresAt?: number;
    expiredUserMessage?: string;
  } = {},
): VerifiedPrompt {
  return { [verifiedPromptBrand]: true, fingerprint, driver, form, ...options };
}

/** Minted only for Codex's parsed `/model` and effort menus. */
export function createVerifiedModelMenuPrompt(
  fingerprint: string,
  driver: AgentDriver,
): VerifiedModelMenuPrompt {
  if (driver.kind !== "codex") throw new Error("model menu prompts are Codex-only");
  return {
    ...createVerifiedPrompt(fingerprint, driver, "digit-then-enter"),
    [verifiedModelMenuPromptBrand]: true,
    capability: "codex-model-menu",
  };
}

export function createBlindPermissionPrompt(
  driver: AgentDriver,
  form: BlindPermissionPrompt["form"],
): BlindPermissionPrompt {
  return { [blindPermissionPromptBrand]: true, driver, form };
}
