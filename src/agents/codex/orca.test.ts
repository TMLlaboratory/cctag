import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { ScreenSnapshot } from "../../backend/types.js";
import type { OrcaProcessAccess, OrcaProcessIdentity } from "../driver.js";
import { CODEX_SHARED_SERVER_NOTICE, codexDriver } from "./driver.js";

function screen(name: string): ScreenSnapshot {
  const { terminal } = JSON.parse(
    readFileSync(new URL(`./__fixtures__/orca-${name}.screen.json`, import.meta.url), "utf8"),
  ) as { terminal: { tail: string[]; draft?: string; source: string; status: string; limited: boolean } };
  return {
    text: terminal.tail.join("\n"),
    draft: terminal.draft ?? null,
    complete: terminal.source === "screen" && terminal.status === "running" && terminal.limited === false,
  };
}

test("Codex's composer is idle only with no turn running and no dialog in front of it", () => {
  const idle = codexDriver.isIdleComposer!;
  assert.equal(idle(screen("idle-fresh")), true, "fresh session");
  assert.equal(idle(screen("idle-after-turn")), true, "after a turn");
  // Typed text is Orca's draft, which submit refuses on its own; the composer itself is still idle.
  assert.equal(idle(screen("draft")), true, "with a draft");
  assert.equal(idle(screen("working")), false, "a turn running, composer still shown");
  assert.equal(idle(screen("approval")), false, "an approval dialog");
  assert.equal(idle({ ...screen("idle-fresh"), complete: false }), false, "an incomplete read");
});

const heads = JSON.parse(readFileSync(new URL("./__fixtures__/orca-rollout-heads.json", import.meta.url), "utf8")) as {
  user: { payload: { id: string } };
  guardian: { payload: { id: string } };
};
const CWD = "/work";
const PID = 72464;
const rollout = (id: string) => `/home/.codex/sessions/2026/10/11/rollout-2026-10-11T17-22-35-${id}.jsonl`;
const headFor = (record: { payload: object }) => `${JSON.stringify({ ...record, payload: { ...record.payload, cwd: CWD } })}\n`;
const USER = rollout(heads.user.payload.id);
const GUARDIAN = rollout(heads.guardian.payload.id);

/** lsof -FftpaDin rows for the files the process holds, in the shape lsof prints them. */
function descriptors(files: Array<{ path: string; fd: number; mode: "r" | "w" | "u"; inode: number }>): string {
  return [`p${PID}`, ...files.flatMap((f) => [`f${f.fd}`, `a${f.mode}`, "tREG", "D0x1000010", `i${f.inode}`, `n${f.path}`])].join("\n");
}

function access(options: {
  open: Array<{ path: string; fd: number; mode: "r" | "w" | "u"; inode: number }>;
  heads?: Record<string, string>;
  otherWriter?: boolean;
}): OrcaProcessAccess {
  const inodes = new Map(options.open.map((f) => [f.path, f.inode]));
  const contents = options.heads ?? { [USER]: headFor(heads.user), [GUARDIAN]: headFor(heads.guardian) };
  return {
    homeDir: "/home",
    readFile: async () => {
      throw new Error("not used");
    },
    readTranscriptHead: async (path) => contents[path] ?? "",
    runSystem: async (file, args) => {
      if (file === "lsof" && args[0] === "-a") return descriptors(options.open);
      if (file === "stat") return `${0x1000010} ${inodes.get(args.at(-1)!)}`;
      if (file === "lsof" && args[0] === "-Fpa") {
        return [`p${PID}`, "f52", "au", ...(options.otherWriter ? ["p999", "f9", "aw"] : [])].join("\n");
      }
      throw new Error(`unexpected ${file} ${args.join(" ")}`);
    },
  };
}

const PROCESS: OrcaProcessIdentity = { pid: PID, command: "codex --no-daemon", cwd: CWD, piCodingAgentDirSet: false };
const session = codexDriver.orcaProcess!.session!;

test("a Codex TUI is bound to the user's rollout it writes, skipping the guardian's", async () => {
  const bound = await session(
    PROCESS,
    access({
      open: [
        { path: USER, fd: 21, mode: "u", inode: 11 },
        { path: GUARDIAN, fd: 52, mode: "u", inode: 12 },
      ],
    }),
  );
  assert.deepEqual(bound, {
    sessionId: heads.user.payload.id,
    transcriptIdentity: { path: USER, device: String(0x1000010), inode: "11" },
  });
});

test("a Codex TUI on the shared background server holds no rollout and gets no binding", async () => {
  assert.equal(await session(PROCESS, access({ open: [] })), null);
  assert.match(CODEX_SHARED_SERVER_NOTICE, /Run each Codex terminal on its own server/);
});

test("a Codex binding is refused rather than guessed", async () => {
  const userOpen = { path: USER, fd: 21, mode: "u" as const, inode: 11 };
  const second = rollout("01a12a0e-0000-7000-8000-000000000000");
  const cases = {
    "only read, not written": access({ open: [{ ...userOpen, mode: "r" }] }),
    "two user threads": access({
      open: [userOpen, { path: second, fd: 22, mode: "u", inode: 13 }],
      heads: {
        [USER]: headFor(heads.user),
        [second]: headFor({ payload: { ...heads.user.payload, id: "01a12a0e-0000-7000-8000-000000000000" } }),
      },
    }),
    "another process writes it too": access({ open: [userOpen], otherWriter: true }),
    "its cwd is not the process's": access({
      open: [userOpen],
      heads: { [USER]: `${JSON.stringify(heads.user)}\n` },
    }),
    "its id is not the file's": access({
      open: [userOpen],
      heads: { [USER]: headFor({ payload: { ...heads.user.payload, id: "01a12a0e-0000-7000-8000-000000000000" } }) },
    }),
    "its first line is not session_meta": access({ open: [userOpen], heads: { [USER]: '{"type":"response_item"}\n' } }),
  };
  for (const [name, fake] of Object.entries(cases)) {
    assert.equal(await session(PROCESS, fake), null, name);
  }
});
