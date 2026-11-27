import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeDriver } from "../agents/claude/driver.js";
import { codexDriver, parseCodexModelMenuPrompt } from "../agents/codex/driver.js";
import { HerdrBackend } from "./herdr.js";
import type { SubmitContext } from "./index.js";
import { BackendUnavailable, ExpectationLost, SubmitRefused, type AgentRef } from "./types.js";
import type { VerifiedModelMenuPrompt, VerifiedPrompt } from "./prompt.js";

function fakeHerdrCli(
  statuses: (string | null)[] = ["idle"],
  paneId = "wT:p1",
  paneTexts: string[] = [],
  socket?: string,
  agentKind = "claude",
): {
  bin: string;
  calls(): string[][];
  cleanup(): void;
} {
  const dir = mkdtempSync(join(tmpdir(), "cctag-herdr-cli-"));
  const bin = join(dir, "herdr-test");
  const callsFile = join(dir, "calls.jsonl");
  const counterFile = join(dir, "status-count");
  const paneReadCountFile = join(dir, "pane-read-count");
  const script = `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(args) + "\\n");
const statuses = ${JSON.stringify(statuses)};
const paneTexts = ${JSON.stringify(paneTexts)};
const socket = ${JSON.stringify(socket ?? null)};
if (socket && args[0] !== "status" && fs.readFileSync(${JSON.stringify(callsFile)}, "utf8").includes('"status","server"')
  && (process.env.HERDR_SOCKET_PATH !== socket || process.env.HERDR_CLIENT_SOCKET_PATH || process.env.HERDR_SESSION)) {
  process.exit(42);
}
function agent(status) {
  return {
    agent: ${JSON.stringify(agentKind)},
    agent_session: { kind: "id", value: "session-1" },
    agent_status: status,
    cwd: "/tmp/project",
    terminal_id: "raw-terminal-id",
    name: "pane-name",
    terminal_title_stripped: " Shell ",
    pane_id: ${JSON.stringify(paneId)}
  };
}
if (args[0] === "status" && args[1] === "server") {
  process.stdout.write(JSON.stringify({ running: true, compatible: true, socket }));
} else if (args[0] === "pane" && args[1] === "layout") {
  process.stdout.write(JSON.stringify({ result: { layout: { panes: [{ pane_id: ${JSON.stringify(paneId)}, rect: { width: 54 } }] } } }));
} else if (args[0] === "pane" && args[1] === "get" && socket) {
  process.stdout.write(JSON.stringify({ result: { pane: { terminal_id: "raw-terminal-id", scroll: { offset_from_bottom: 0 } } } }));
} else if (args[0] === "pane" && args[1] === "process-info" && socket) {
  const pid = ${process.pid};
  const processes = [{ pid, name: "claude" }];
  if (fs.readFileSync(${JSON.stringify(callsFile)}, "utf8").includes('"agent","prompt",${JSON.stringify(paneId)},"typed message"')) {
    processes.push({ pid: pid + 1, name: "caffeinate" });
  }
  process.stdout.write(JSON.stringify({ result: { process_info: {
    pane_id: ${JSON.stringify(paneId)}, foreground_process_group_id: pid, foreground_processes: processes
  } } }));
} else if (args[0] === "agent" && args[1] === "list") {
  process.stdout.write(JSON.stringify({ result: { agents: [agent("working")] } }));
} else if (args[0] === "agent" && args[1] === "get") {
  const count = Number(fs.existsSync(${JSON.stringify(counterFile)}) ? fs.readFileSync(${JSON.stringify(counterFile)}, "utf8") : "0");
  fs.writeFileSync(${JSON.stringify(counterFile)}, String(count + 1));
  const status = statuses[Math.min(count, statuses.length - 1)];
  process.stdout.write(JSON.stringify({ result: status === null ? {} : { agent: agent(status) } }));
} else if (args[0] === "pane" && args[1] === "read") {
  if (paneTexts.length > 0) {
    const count = Number(fs.existsSync(${JSON.stringify(paneReadCountFile)}) ? fs.readFileSync(${JSON.stringify(paneReadCountFile)}, "utf8") : "0");
    fs.writeFileSync(${JSON.stringify(paneReadCountFile)}, String(count + 1));
    process.stdout.write(paneTexts[Math.min(count, paneTexts.length - 1)]);
  } else {
    process.stdout.write(args[4] === "visible" ? "visible snapshot" : "history snapshot");
  }
} else {
  process.stdout.write(JSON.stringify({ result: {} }));
}
`;
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  return {
    bin,
    calls() {
      try {
        return readFileSync(callsFile, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as string[]);
      } catch {
        return [];
      }
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function submitContext(
  retryLimit: number,
  options: Partial<Pick<SubmitContext, "cancelled" | "transcriptGrew" | "pollIntervalMs">> = {},
): SubmitContext {
  return {
    driver: codexDriver,
    cancelled: options.cancelled ?? (() => false),
    transcriptGrew: options.transcriptGrew ?? (() => false),
    retryLimit,
    pollIntervalMs: options.pollIntervalMs ?? 1,
  };
}
function permissionPane(command: string, cursorOn = 1): string {
  const options = ["Yes", "Yes, and don't ask again", "No, and tell Claude what to do differently"];
  return [
    "Bash command",
    "",
    `  ${command}`,
    "",
    "Do you want to proceed?",
    ...options.map((label, i) => `${i + 1 === cursorOn ? "❯" : " "} ${i + 1}. ${label}`),
  ].join("\n");
}

function verifiedPermission(paneText: string): VerifiedPrompt {
  const prompt = claudeDriver.parseBlockedPane(paneText);
  if (prompt.kind !== "permission") throw new Error(`expected parsed permission, got ${prompt.kind}`);
  return prompt.verified;
}

const CODEX_MODEL_MENU = [
  "Select Model and Effort",
  "› 1. GPT-6-Astra",
  "  2. GPT-5.6-sol",
  "Press enter to confirm",
].join("\n");
const CODEX_EFFORT_MENU = [
  "Select Reasoning Level for GPT-6-Astra",
  "› 1. High",
  "  2. Medium",
  "Press enter to confirm",
].join("\n");
// Sanitized approval rows from design/capture/C-codex-3-permission-dialog-screen.txt.
const CODEX_APPROVAL_MENU = [
  "Permission selection requested: Ask for approval",
  "› 1. Yes, proceed (y)",
  "  2. Yes, and don't ask again for commands with this prefix",
  "  3. No, and tell Codex what to do differently (esc)",
  "Press enter to confirm or esc to cancel",
].join("\n");

function verifiedCodexModelPrompt(paneText = CODEX_MODEL_MENU): VerifiedModelMenuPrompt {
  const prompt = parseCodexModelMenuPrompt(paneText);
  if (!prompt) throw new Error("expected Codex model-menu prompt");
  return prompt;
}

const REF: AgentRef = { target: "wT:p1", pid: null, processStartedAt: null };

test("Herdr preserves normalized IDs and read regions", async () => {
  const cli = fakeHerdrCli();
  try {
    const backend = new HerdrBackend(cli.bin);
    const listed = await backend.list();
    assert.equal(listed.complete, true);
    assert.deepEqual(listed.failures, []);
    assert.equal(listed.agents[0].ref.target, "wT:p1");
    assert.equal(listed.agents[0].ref.pid, null);
    assert.equal(listed.agents[0].sessionId, "session-1");
    assert.deepEqual(listed.agents[0].evidence, { kind: "classified", status: "working" });
    assert.equal(listed.agents[0].terminalTitle, "Shell");
    assert.equal(listed.agents[0].terminalId, "raw-terminal-id");
    assert.equal(listed.agents[0].displayId, "pane-name");

    const screen = await backend.read("wT:p1", 12, "screen");
    const history = await backend.read("wT:p1", 20, "history");
    assert.deepEqual(screen, { text: "visible snapshot", draft: null, complete: true });
    assert.deepEqual(history, { text: "history snapshot", draft: null, complete: true });


    assert.deepEqual(cli.calls().slice(1), [
      ["pane", "read", "wT:p1", "--source", "visible", "--lines", "12"],
      ["pane", "read", "wT:p1", "--source", "recent", "--lines", "20"],
    ]);
  } finally {
    cli.cleanup();
  }
});

test("Herdr rejects pane IDs in the reserved Orca namespace", async () => {
  const cli = fakeHerdrCli(["idle"], "orca:collision");
  try {
    const backend = new HerdrBackend(cli.bin);
    await assert.rejects(backend.get("wT:p1"), BackendUnavailable);
    const listed = await backend.list();
    assert.equal(listed.complete, false);
    assert.equal(listed.agents.length, 0);
    assert.match(listed.failures[0].reason, /orca:collision/);
  } finally {
    cli.cleanup();
  }
});

test("submit retries only while the agent remains idle or done", async () => {
  const cli = fakeHerdrCli(["idle", "done", "working"], REF.target, [], undefined, "codex");
  try {
    const backend = new HerdrBackend(cli.bin);
    const outcome = await backend.submit(REF, "hello", submitContext(6));
    assert.deepEqual(outcome, { status: "accepted", draftStashed: false });
    assert.deepEqual(cli.calls(), [
      ["agent", "prompt", "wT:p1", "hello"],
      ["agent", "get", "wT:p1"],
      ["pane", "send-keys", "wT:p1", "Enter"],
      ["agent", "get", "wT:p1"],
      ["pane", "send-keys", "wT:p1", "Enter"],
      ["agent", "get", "wT:p1"],
    ]);
  } finally {
    cli.cleanup();
  }
});

test("submit respects its retry budget and stops on transcript growth or cancellation", async () => {
  const budgetCli = fakeHerdrCli(["idle", "idle", "idle"], REF.target, [], undefined, "codex");
  try {
    const backend = new HerdrBackend(budgetCli.bin);
    await backend.submit(REF, "budget", submitContext(2));
    assert.equal(budgetCli.calls().filter((args) => args[0] === "pane").length, 2);
  } finally {
    budgetCli.cleanup();
  }

  const growthCli = fakeHerdrCli(["idle"]);
  try {
    const backend = new HerdrBackend(growthCli.bin);
    await backend.submit(REF, "growth", submitContext(6, { transcriptGrew: () => true }));
    assert.deepEqual(growthCli.calls(), [["agent", "prompt", "wT:p1", "growth"]]);
  } finally {
    growthCli.cleanup();
  }

  const cancelledCli = fakeHerdrCli(["idle"]);
  try {
    const backend = new HerdrBackend(cancelledCli.bin);
    await backend.submit(REF, "cancelled", submitContext(6, { cancelled: () => true }));
    assert.deepEqual(cancelledCli.calls(), [["agent", "prompt", "wT:p1", "cancelled"]]);
  } finally {
    cancelledCli.cleanup();
  }
});

test("submit does not resend when the agent is missing or not idle", async () => {
  for (const status of [null, "blocked"] as const) {
    const cli = fakeHerdrCli([status], REF.target, [], undefined, "codex");
    try {
      const backend = new HerdrBackend(cli.bin);
      await backend.submit(REF, "hello", submitContext(6));
      assert.deepEqual(cli.calls(), [
        ["agent", "prompt", "wT:p1", "hello"],
        ["agent", "get", "wT:p1"],
      ]);
    } finally {
      cli.cleanup();
    }
  }
});

const HERDR_PAINTS = JSON.parse(readFileSync(new URL(
  "../agents/claude/__fixtures__/herdr-composer.ansi.json", import.meta.url,
), "utf8")) as Record<string, string>;

test("legacy Claude pins the socket, checks for hidden space, and replaces a verified standalone suggestion", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cctag-visible-"));
  const socketPath = join(dir, "herdr.sock");
  assert.equal(HERDR_PAINTS["review-home-empty"], HERDR_PAINTS["review-home-space"]);
  const probeSuggestion = ["suggestion", "suggestion", "suggestion-x", "suggestion-x", "suggestion-backspace"];
  const probeTyped = ["typed", "typed", "typed-x", "typed-x", "typed-backspace"];
  const paints = [
    "review-home-empty", "review-home-empty", "review-home-empty",
    "review-home-empty", "review-home-empty", "review-empty-probed", "review-empty-probed",
    "review-empty-restored", "review-empty-restored",
    "review-home-space", "review-home-space", "review-hidden-probed", "review-hidden-probed", "review-hidden-restored",
    ...probeTyped,
    ...probeSuggestion, "suggestion-backspace",
    ...probeSuggestion, "typed",
    ...probeTyped, "typed-backspace",
    "review-stashed", "review-stashed", "review-stashed-probed", "review-stashed-probed", "review-stashed", "review-stashed",
    "empty", "empty",
  ];
  let readCount = 0;
  const server = createServer((socket) => {
    socket.once("data", (data) => {
      const request = JSON.parse(data.toString());
      assert.equal(request.method, "pane.read");
      assert.deepEqual(request.params, { pane_id: REF.target, source: "visible", format: "ansi", strip_ansi: false });
      const text = HERDR_PAINTS[paints[readCount++]!];
      assert.equal(typeof text, "string");
      socket.end(JSON.stringify({
        id: request.id, result: { type: "pane_read", read: {
          pane_id: REF.target, source: "visible", format: "ansi", text, truncated: readCount === paints.length - 1,
        } },
      }) + "\n");
    });
  });
  const cli = fakeHerdrCli(["idle"], REF.target, [], socketPath);
  const saved = { ...process.env };
  process.env.HERDR_SOCKET_PATH = "/tmp/a-different-server.sock";
  process.env.HERDR_CLIENT_SOCKET_PATH = "/tmp/a-different-client.sock";
  process.env.HERDR_SESSION = "different-session";
  try {
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const backend = new HerdrBackend(cli.bin);
    const agent = await backend.get(REF.target);
    assert.ok(agent);
    assert.equal(agent.ref.pid, null);
    assert.deepEqual(cli.calls(), [["agent", "get", REF.target]]);
    const ctx = { ...submitContext(5), driver: claudeDriver };
    await assert.rejects(backend.submit(agent.ref, "image prompt", { ...ctx, hasImages: true }),
      (error) => error instanceof SubmitRefused && error.reason === "legacy-claude-images");
    assert.deepEqual(cli.calls(), [["agent", "get", REF.target]]);
    await assert.rejects(backend.submit({ ...agent.ref, terminalInstance: "replaced", sessionId: null }, "replaced terminal", ctx),
      (error) => error instanceof SubmitRefused && error.reason === "agent-changed");
    await assert.rejects(backend.submit({ ...agent.ref, sessionId: null }, "unverified session", ctx),
      (error) => error instanceof SubmitRefused && error.reason === "foreground-unverified");
    await assert.rejects(backend.submit({ ...agent.ref, sessionId: "replaced" }, "different session", ctx),
      (error) => error instanceof SubmitRefused && error.reason === "agent-changed");
    await assert.rejects(backend.submit({ ...agent.ref, pid: process.pid, processStartedAt: 1 }, "replaced process", ctx),
      (error) => error instanceof SubmitRefused && error.reason === "agent-changed");
    assert.deepEqual(await backend.submit(agent.ref, "/model haiku", ctx), { status: "accepted", draftStashed: false });
    await assert.rejects(backend.submit(agent.ref, "hidden text", ctx),
      (error) => error instanceof SubmitRefused && error.reason === "draft" && error.composer.probe === null);
    await assert.rejects(backend.submit(agent.ref, "/model haiku", ctx),
      (error) => error instanceof SubmitRefused && error.reason === "draft");
    assert.deepEqual(await backend.submit(agent.ref, "/model haiku", ctx), { status: "accepted", draftStashed: false });
    await assert.rejects(backend.submit(agent.ref, "changed suggestion", ctx),
      (error) => error instanceof SubmitRefused && error.reason === "draft");
    assert.deepEqual(await backend.submit(agent.ref, "typed message", ctx), {
      status: "accepted", draftStashed: true,
    });
    await assert.rejects(backend.submit(agent.ref, "blocked", ctx),
      (error) => error instanceof SubmitRefused && error.reason === "incomplete-screen");
    await assert.rejects(backend.submit(agent.ref, "foreground with caffeinate", ctx),
      (error) => error instanceof SubmitRefused && error.reason === "foreground-unverified");
    assert.deepEqual(cli.calls().filter((args) => ["prompt", "send-keys"].includes(args[1]!)), [
      ["pane", "send-keys", REF.target, "right", "x"],
      ["pane", "send-keys", REF.target, "backspace"],
      ["agent", "prompt", REF.target, "/model haiku"],
      ["pane", "send-keys", REF.target, "right", "x"],
      ["pane", "send-keys", REF.target, "backspace", "left"],
      ["pane", "send-keys", REF.target, "x"],
      ["pane", "send-keys", REF.target, "backspace"],
      ["pane", "send-keys", REF.target, "x"],
      ["pane", "send-keys", REF.target, "backspace"],
      ["agent", "prompt", REF.target, "/model haiku"],
      ["pane", "send-keys", REF.target, "x"],
      ["pane", "send-keys", REF.target, "backspace"],
      ["pane", "send-keys", REF.target, "x"],
      ["pane", "send-keys", REF.target, "backspace"],
      ["pane", "send-keys", REF.target, "ctrl+s"],
      ["pane", "send-keys", REF.target, "right", "x"],
      ["pane", "send-keys", REF.target, "backspace"],
      ["agent", "prompt", REF.target, "typed message"],
    ]);
  } finally {
    for (const name of ["HERDR_SOCKET_PATH", "HERDR_CLIENT_SOCKET_PATH", "HERDR_SESSION"]) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    cli.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("VerifiedPrompt cannot be forged from an object literal", () => {
  // @ts-expect-error the brand symbol is private to backend/prompt.ts
  const forged: VerifiedPrompt = { fingerprint: "fp", driver: claudeDriver, form: "digit-confirms" };
  assert.equal(forged.fingerprint, "fp");
});
test("Herdr model answer and composer channels preserve verified writes", async () => {
  const cli = fakeHerdrCli(["idle"], "wT:p1", [CODEX_MODEL_MENU]);
  try {
    const backend = new HerdrBackend(cli.bin);
    const channel = backend.openModelAnswer(REF, verifiedCodexModelPrompt());
    await channel.digit(1);
    await channel.move("Down", 2);
    await channel.confirm("this deliberately mismatches the menu cursor");
    const afterConfirm = cli.calls();
    await assert.rejects(channel.digit(2), ExpectationLost);
    await backend.openComposer(REF, claudeDriver).backTab();

    assert.deepEqual(cli.calls(), [
      ["pane", "read", "wT:p1", "--source", "visible", "--lines", "200"],
      ["pane", "send-text", "wT:p1", "1"],
      ["pane", "send-keys", "wT:p1", "Down", "Down"],
      ["pane", "send-keys", "wT:p1", "Enter"],
      ["pane", "send-text", "wT:p1", "\u001b[Z"],
    ]);
    assert.equal(afterConfirm.length, 4, "confirm adds no cursor read");
  } finally {
    cli.cleanup();
  }
});

test("ordinary Codex approval cannot open a model channel", () => {
  const ordinary = codexDriver.parseBlockedPane(CODEX_APPROVAL_MENU);
  if (ordinary.kind !== "permission") throw new Error(`expected Codex menu, got ${ordinary.kind}`);
  assert.equal(parseCodexModelMenuPrompt(CODEX_APPROVAL_MENU), null);

  const cli = fakeHerdrCli();
  try {
    const backend = new HerdrBackend(cli.bin);
    assert.throws(() => {
      // @ts-expect-error generic approval prompts do not carry the model-menu capability
      backend.openModelAnswer(REF, ordinary.verified);
    }, ExpectationLost);
    assert.deepEqual(cli.calls(), [], "refusal happens before any pane read or write");
  } finally {
    cli.cleanup();
  }
});

test("Herdr model channels accept both Codex /model stages", async () => {
  for (const paneText of [CODEX_MODEL_MENU, CODEX_EFFORT_MENU]) {
    const cli = fakeHerdrCli(["idle"], "wT:p1", [paneText]);
    try {
      const backend = new HerdrBackend(cli.bin);
      const channel = backend.openModelAnswer(REF, verifiedCodexModelPrompt(paneText));
      await channel.move("Down", 1);
      await channel.confirm("selected /model row");
      assert.deepEqual(cli.calls(), [
        ["pane", "read", "wT:p1", "--source", "visible", "--lines", "200"],
        ["pane", "send-keys", "wT:p1", "Down"],
        ["pane", "send-keys", "wT:p1", "Enter"],
      ]);
    } finally {
      cli.cleanup();
    }
  }
});

test("Claude answer channels expose no Escape after a digit-confirmed answer", async () => {
  const paneText = permissionPane("echo hello");
  const cli = fakeHerdrCli(["idle"], "wT:p1", [paneText]);
  try {
    const backend = new HerdrBackend(cli.bin);
    const channel = backend.openAnswer(REF, verifiedPermission(paneText));
    await channel.digit(1);
    const beforeEscapeAttempt = cli.calls();
    assert.equal("escape" in channel, false);
    await assert.rejects(channel.move("Down", 1), ExpectationLost);
    assert.deepEqual(cli.calls(), beforeEscapeAttempt, "refused follow-up produces no write");
  } finally {
    cli.cleanup();
  }
});

test("Codex model Escape ends its channel without allowing later writes", async () => {
  const cli = fakeHerdrCli(["idle"], "wT:p1", [CODEX_MODEL_MENU]);
  try {
    const backend = new HerdrBackend(cli.bin);
    const channel = backend.openModelAnswer(REF, verifiedCodexModelPrompt());
    await channel.escape();
    await assert.rejects(channel.confirm("ignored after Escape"), ExpectationLost);
    assert.deepEqual(cli.calls(), [
      ["pane", "read", "wT:p1", "--source", "visible", "--lines", "200"],
      ["pane", "send-keys", "wT:p1", "Escape"],
    ]);
  } finally {
    cli.cleanup();
  }
});

test("Herdr blind permission channel sends only one y or n and no Enter to Claude Code", async () => {
  for (const choice of ["y", "n"] as const) {
    const cli = fakeHerdrCli();
    try {
      const backend = new HerdrBackend(cli.bin);
      const prompt = claudeDriver.parseBlockedPane("unparsed permission request");
      if (prompt.kind !== "blind-permission") throw new Error(`expected blind permission, got ${prompt.kind}`);
      await backend.openBlind(REF, prompt.blind).answer(choice);
      assert.deepEqual(cli.calls(), [["pane", "send-text", "wT:p1", choice]]);
    } finally {
      cli.cleanup();
    }
  }
});

test("Herdr blind permission channel follows y or n with Enter on Codex", async () => {
  // Codex's approval menu says "Press enter to confirm": the key alone does not
  // answer it, so the pane would sit waiting while Slack showed it answered.
  for (const choice of ["y", "n"] as const) {
    const cli = fakeHerdrCli();
    try {
      const backend = new HerdrBackend(cli.bin);
      const prompt = codexDriver.parseBlockedPane("unparsed approval request");
      if (prompt.kind !== "blind-permission") throw new Error(`expected blind permission, got ${prompt.kind}`);
      await backend.openBlind(REF, prompt.blind).answer(choice);
      assert.deepEqual(cli.calls(), [
        ["pane", "send-text", "wT:p1", choice],
        ["pane", "send-keys", "wT:p1", "Enter"],
      ]);
    } finally {
      cli.cleanup();
    }
  }
});

test("Herdr refuses the first answer write when the prompt fingerprint changed", async () => {
  const intendedPane = permissionPane("echo intended");
  const changedPane = permissionPane("echo changed");
  const cli = fakeHerdrCli(["idle"], "wT:p1", [changedPane]);
  try {
    const backend = new HerdrBackend(cli.bin);
    const channel = backend.openAnswer(REF, verifiedPermission(intendedPane));
    await assert.rejects(channel.digit(1), ExpectationLost);
    assert.deepEqual(cli.calls(), [["pane", "read", "wT:p1", "--source", "recent", "--lines", "200"]]);
  } finally {
    cli.cleanup();
  }
});

test("Herdr confirm preserves Enter without reading the cursor label", async () => {
  const paneText = permissionPane("echo hello");
  const cli = fakeHerdrCli(["idle"], "wT:p1", [paneText]);
  try {
    const backend = new HerdrBackend(cli.bin);
    const channel = backend.openAnswer(REF, verifiedPermission(paneText));
    await channel.confirm("No, and tell Claude what to do differently");
    await assert.rejects(channel.digit(1), ExpectationLost);
    assert.deepEqual(cli.calls(), [
      ["pane", "read", "wT:p1", "--source", "recent", "--lines", "200"],
      ["pane", "send-keys", "wT:p1", "Enter"],
    ]);
  } finally {
    cli.cleanup();
  }
});

test("compound answer channels keep Submit open through the final action", async () => {
  const paneText = permissionPane("echo hello");

  const reviewCli = fakeHerdrCli(["idle"], "wT:p1", [paneText]);
  try {
    const backend = new HerdrBackend(reviewCli.bin);
    const channel = backend.openAnswer(REF, verifiedPermission(paneText));
    await channel.confirm("Submit", false);
    await channel.digit(1, true);
    await assert.rejects(channel.move("Down", 1), ExpectationLost);
    assert.deepEqual(reviewCli.calls(), [
      ["pane", "read", "wT:p1", "--source", "recent", "--lines", "200"],
      ["pane", "send-keys", "wT:p1", "Enter"],
      ["pane", "send-text", "wT:p1", "1"],
    ]);
  } finally {
    reviewCli.cleanup();
  }

  const submitCli = fakeHerdrCli(["idle"], "wT:p1", [paneText]);
  try {
    const backend = new HerdrBackend(submitCli.bin);
    const channel = backend.openAnswer(REF, verifiedPermission(paneText));
    await channel.confirm("Submit", false);
    channel.complete();
    await assert.rejects(channel.digit(1), ExpectationLost);
    assert.deepEqual(submitCli.calls(), [
      ["pane", "read", "wT:p1", "--source", "recent", "--lines", "200"],
      ["pane", "send-keys", "wT:p1", "Enter"],
    ]);
  } finally {
    submitCli.cleanup();
  }
});

test("Herdr reads drop a Claude Code mod's side pane, so the question beside it parses", async () => {
  const { text } = JSON.parse(
    readFileSync(new URL("../agents/claude/__fixtures__/side-pane-question-herdr.screen.json", import.meta.url), "utf8"),
  ) as { text: string };
  assert.equal(claudeDriver.parseBlockedPane(text).kind, "blind-permission", "unstripped, it reads as a y/n menu");

  const cli = fakeHerdrCli(["idle"], "wT:p1", [text]);
  try {
    const snapshot = await new HerdrBackend(cli.bin).read("wT:p1", 200, "history");
    const prompt = claudeDriver.parseBlockedPane(snapshot.text);
    assert.equal(prompt.kind, "question");
    if (prompt.kind !== "question") return;
    assert.equal(prompt.info.question, "Hub の Spoke 無応答検知（heartbeat）のテストは、どの方針で書きますか？");
    assert.deepEqual(
      prompt.info.options.map((o) => o.label),
      ["フェイククロック単体テスト", "実 Hub・実 Spoke の統合テスト", "単体＋実機キャプチャ併用"],
    );
  } finally {
    cli.cleanup();
  }
});
