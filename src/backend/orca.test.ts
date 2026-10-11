import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentPickerBlocks } from "../slack/blocks.js";
import { claudeDriver } from "../agents/claude/driver.js";
import { OMP_RESUME_NOTICE, ompDriver } from "../agents/omp/driver.js";
import type { SubmitContext } from "./index.js";
import type { OrcaRuntime, OrcaExecResult } from "./orca.js";
import { createOrcaRuntime, OrcaBackend } from "./orca.js";
import {
  BackendUnavailable,
  ExpectationLost,
  SubmitRefused,
  UnknownTarget,
  WriteOutcomeUnknown,
  type AgentRef,
} from "./types.js";

type JsonObject = Record<string, unknown>;

interface ProcessFixture {
  pid: number;
  ppid: number;
  pgid: number;
  tpgid: number;
  tty: string;
  lstart: string;
  command: string;
  paneKey?: string;
  terminalHandle?: string;
  cwd?: string;
  piCodingAgentDir?: string;
}

interface CapturedProcess extends ProcessFixture {
  environment: { ORCA_PANE_KEY: string; ORCA_TERMINAL_HANDLE: string };
}

interface SessionTransition {
  terminalList: { terminals: JsonObject[]; truncated: boolean };
  process: ProcessFixture & { environment: { ORCA_PANE_KEY: string; ORCA_TERMINAL_HANDLE: string } };
  sessionFile: Record<string, unknown>;
}

function object(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : null;
}

function objectRows(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.map(object).filter((row): row is JsonObject => row !== null) : [];
}

function readJsonFixture(path: string): JsonObject {
  const value = JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as unknown;
  const row = object(value);
  if (!row) throw new Error(`fixture ${path} is not a JSON object`);
  return row;
}

function responseResult(response: JsonObject): JsonObject {
  const result = object(response.result);
  if (!result) throw new Error("captured Orca response has no result object");
  return result;
}

const worktreePsCapture = readJsonFixture("./__fixtures__/orca/worktree-ps-question-state.json");
const terminalListCapture = readJsonFixture("./__fixtures__/orca/terminal-list-question-state.json");
const terminalShowCapture = readJsonFixture("./__fixtures__/orca/terminal-show-question-state.json");
const terminalReadCapture = readJsonFixture("./__fixtures__/orca/terminal-read-question-state.json");
const terminalSendCapture = readJsonFixture("./__fixtures__/orca/terminal-send-receipt.json");
const ompTerminalSendCapture = readJsonFixture("./__fixtures__/orca/omp/terminal-send-unsupported.json");
const ompSingleOpenerCapture = readJsonFixture("./__fixtures__/orca/omp/single-opener-lsof.json");
const hooksStatusCapture = readJsonFixture("./__fixtures__/orca/agent-hooks-status.json");
const staleShowCapture = readJsonFixture("./__fixtures__/orca/terminal-show-stale-error.json");
const transitions = readJsonFixture("./__fixtures__/orca/claude-session-transitions.json") as {
  snapshots: Array<SessionTransition & { state: string }>;
};
const terminalListResult = responseResult(terminalListCapture);
const terminalListTemplateRow = objectRows(terminalListResult.terminals).find(
  (terminal) => terminal.agentIdentity === "claude",
);
if (!terminalListTemplateRow) throw new Error("terminal-list capture has no Claude terminal row");
const worktreePsResult = responseResult(worktreePsCapture);
const worktreeQuestionAgent = objectRows(worktreePsResult.worktrees)
  .flatMap((worktree) => objectRows(worktree.agents))
  .find((agent) => agent.state === "waiting" && agent.toolName === "AskUserQuestion");
if (!worktreeQuestionAgent) throw new Error("worktree-ps capture has no waiting question agent");
const capturedReadTerminal = object(responseResult(terminalReadCapture).terminal) ?? {};
const capturedSendResult = responseResult(terminalSendCapture);
const capturedOmpSendResult = responseResult(ompTerminalSendCapture);
const capturedHooksResult = responseResult(hooksStatusCapture);
function withSendStages(templateResult: JsonObject, stages: readonly string[], accepted = true): JsonObject {
  const send = object(templateResult.send);
  const prompt = object(send?.prompt);
  if (!send || !prompt) throw new Error("captured Orca send result has no send prompt");
  return {
    ...templateResult,
    send: { ...send, accepted, prompt: { ...prompt, stages: [...stages] } },
  };
}
const PANE = "<tab-B>:<leaf-B>";
const HANDLE = "<terminal-B>";
const TARGET = `orca:${PANE}`;
const HOME = "/fake-home";
const SESSION_PATH = (pid: number) => `${HOME}/.claude/sessions/${pid}.json`;

// The selected process row is synthetic; the raw `ps`/`lsof` observations were not retained.
const capture: { process: CapturedProcess } = {
  process: {
    pid: 32521,
    ppid: 32467,
    pgid: 32521,
    tpgid: 32521,
    tty: "ttys019",
    lstart: "Mon Sep 28 20:28:02 2026",
    command: "claude",
    environment: { ORCA_PANE_KEY: PANE, ORCA_TERMINAL_HANDLE: HANDLE },
  },
};

function successResponse(template: JsonObject, result: JsonObject): OrcaExecResult {
  return {
    stdout: JSON.stringify({ ...template, ok: true, result }),
    stderr: "",
    exitCode: 0,
  };
}

function failure(code: string, message: string): OrcaExecResult {
  const error = object(staleShowCapture.error) ?? {};
  return {
    stdout: JSON.stringify({ ...staleShowCapture, ok: false, error: { ...error, code, message } }),
    stderr: "",
    exitCode: 1,
  };
}


function processLine(row: ProcessFixture): string {
  return `${row.pid} ${row.ppid} ${row.pgid} ${row.tpgid} ${row.tty} ${row.lstart} ${row.command}`;
}

function terminalFor(paneKey: string, handle: string, overrides: JsonObject = {}): JsonObject {
  const [tabId, leafId] = paneKey.split(":");
  return {
    handle,
    tabId,
    leafId,
    writable: true,
    connected: true,
    agentIdentity: "claude",
    ...overrides,
  };
}

class FakeOrcaRuntime implements OrcaRuntime {
  readonly homeDir = HOME;
  readonly bin = "/fake/orca";
  readonly calls: Array<{ file: string; args: string[]; timeoutMs: number }> = [];
  readonly readPaths: string[] = [];
  readonly sessionFiles = new Map<string, string>();
  readonly transcriptHeads = new Map<string, string>();
  readonly descriptorOutputs = new Map<number, string>();
  readonly openerOutputs = new Map<string, string>();
  readonly statOutputs = new Map<string, string>();
  readonly staleHandles = new Set<string>();
  readonly sendCalls: Array<{ args: string[]; timeoutMs: number }> = [];
  acceptedInputWrites = 0;
  sendReceipt: JsonObject = { ...capturedSendResult };
  sendEnvelopeCapture: JsonObject = terminalSendCapture;
  sendFailure: OrcaExecResult | null = null;
  sendFailureAfterAccept = false;
  afterSend: (() => void) | null = null;
  terminalListHook: (() => void) | null = null;
  screenReadHook: (() => void) | null = null;

  processes: ProcessFixture[] = [];
  terminals: JsonObject[] = [];
  terminalListTruncated: unknown = false;
  worktreeAgentsOverride: JsonObject[] | null = null;
  worktreePsTruncated: unknown = worktreePsResult.truncated;
  worktreePsMissingWorktrees = false;
  worktreePsMalformedAgents: "missing" | "non-array" | null = null;
  hookStatuses: JsonObject[] = objectRows(capturedHooksResult.statuses);
  showFields: JsonObject = {};
  screen: JsonObject = { ...capturedReadTerminal };
  screenSequence: JsonObject[] = [];
  terminalListFailure = false;
  /** Listed by `ps -axww`, gone by the time `ps eww` and `lsof` run. */
  readonly exitedAfterPs = new Set<number>();
  lsofStderr = "";

  constructor() {
    this.loadQuestionFixture();
  }

  loadQuestionFixture(): void {
    const process: ProcessFixture = {
      ...capture.process,
      paneKey: capture.process.environment.ORCA_PANE_KEY,
      terminalHandle: capture.process.environment.ORCA_TERMINAL_HANDLE,
      cwd: "/workspace-B",
    };
    this.processes = [process];
    this.terminals = [terminalFor(PANE, HANDLE)];
    this.terminalListTruncated = false;
    this.worktreeAgentsOverride = null;
    this.worktreePsTruncated = worktreePsResult.truncated;
    this.worktreePsMissingWorktrees = false;
    this.worktreePsMalformedAgents = null;
    this.hookStatuses = objectRows(capturedHooksResult.statuses);
    this.showFields = {};
    this.screen = { ...capturedReadTerminal };
    this.sendReceipt = { ...capturedSendResult };
    this.setSession(process.pid, { sessionId: "<session-A>" });
    this.sendEnvelopeCapture = terminalSendCapture;
  }

  setSession(pid: number, session: Record<string, unknown>): void {
    this.sessionFiles.set(SESSION_PATH(pid), JSON.stringify(session));
  }
  setOmpBinding(
    pid: number,
    path: string,
    cwd: string,
    sessionId: string,
    writerFixture: OmpWriterFixture = "v7-main-writer-fields.lsof",
    transcriptFixture: OmpTranscriptFixture = "v4-new-session-head.jsonl",
  ): void {
    const writer = capturedOmpWriter(pid, path, writerFixture);
    this.descriptorOutputs.set(pid, writer.output);
    this.statOutputs.set(path, `${writer.device} ${writer.inode}\n`);
    this.openerOutputs.set(path, capturedOmpOpener(pid, path));
    this.sendEnvelopeCapture = ompTerminalSendCapture;
    this.sendReceipt = { ...capturedOmpSendResult };
    const records = capturedOmpTranscriptHead(transcriptFixture).split(/\r?\n/u);
    const session = JSON.parse(records[1]!) as JsonObject;
    session.id = sessionId;
    session.cwd = cwd;
    records[1] = JSON.stringify(session);
    this.transcriptHeads.set(path, records.join("\n"));
  }


  async readFile(path: string): Promise<string> {
    this.readPaths.push(path);
    const content = this.sessionFiles.get(path);
    if (content === undefined) throw new Error("fake session file is missing");
    return content;
  }
  async readTranscriptHead(path: string): Promise<string> {
    const content = this.transcriptHeads.get(path);
    if (content === undefined) throw new Error("fake transcript head is missing");
    return content;
  }

  async execFile(file: string, args: string[], options: { timeoutMs: number }): Promise<OrcaExecResult> {
    this.calls.push({ file, args: [...args], timeoutMs: options.timeoutMs });
    if (file === "ps") {
      if (args[0] === "-axww") return { stdout: this.processes.map(processLine).join("\n"), stderr: "", exitCode: 0 };
      if (args[0] === "eww") {
        const pidArg = args[args.indexOf("-p") + 1] ?? "";
        const pids = new Set(pidArg.split(",").map(Number));
        const stdout = this.processes
          .filter((row) => pids.has(row.pid) && !this.exitedAfterPs.has(row.pid))
          .map((row) => {
            const environment = [
              row.paneKey ? `ORCA_PANE_KEY=${row.paneKey}` : "",
              row.terminalHandle ? `ORCA_TERMINAL_HANDLE=${row.terminalHandle}` : "",
              row.piCodingAgentDir !== undefined ? `PI_CODING_AGENT_DIR=${row.piCodingAgentDir}` : "",
            ]
              .filter(Boolean)
              .join(" ");
            return `${row.pid} ${row.command}${environment ? ` ${environment}` : ""}`;
          })
          .join("\n");
        return { stdout, stderr: "", exitCode: 0 };
      }
    }
    if (file === "lsof") {
      if (this.lsofStderr) return { stdout: "", stderr: this.lsofStderr, exitCode: 1, error: "Command failed: lsof" };
      if (args.includes("-FftpaDin")) {
        const pid = Number(args[args.indexOf("-p") + 1]);
        const stdout = this.descriptorOutputs.get(pid) ?? "";
        return stdout ? { stdout, stderr: "", exitCode: 0 } : { stdout, stderr: "", exitCode: 1, error: "Command failed: lsof" };
      }
      if (args[0] === "-Fpa") {
        const stdout = this.openerOutputs.get(args[1] ?? "") ?? "";
        return stdout ? { stdout, stderr: "", exitCode: 0 } : { stdout, stderr: "", exitCode: 1, error: "Command failed: lsof" };
      }
      const pidArg = args[args.indexOf("-p") + 1] ?? "";
      const pids = pidArg.split(",").map(Number);
      const live = this.processes.filter((row) => pids.includes(row.pid) && !this.exitedAfterPs.has(row.pid));
      const stdout = live
        .filter((row) => row.cwd)
        .map((row) => `p${row.pid}\nfcwd\nn${row.cwd}`)
        .join("\n");
      return live.length === pids.length
        ? { stdout, stderr: "", exitCode: 0 }
        : { stdout, stderr: "", exitCode: 1, error: `Command failed: lsof ${args.join(" ")}` };
    }
    if (file === "stat") {
      const path = args.at(-1) ?? "";
      return { stdout: this.statOutputs.get(path) ?? "", stderr: "", exitCode: 0 };
    }
    if (file !== this.bin) throw new Error(`unexpected fake command: ${file}`);

    if (args[0] === "terminal" && args[1] === "list") {
      if (this.terminalListFailure) return failure("runtime_unavailable", "runtime not running");
      const terminals = this.terminals.map((terminal) => ({ ...terminalListTemplateRow, ...terminal }));
      const result = successResponse(terminalListCapture, {
        ...terminalListResult,
        terminals,
        totalCount: terminals.length,
        truncated: this.terminalListTruncated,
      });
      this.terminalListHook?.();
      return result;
    }
    if (args[0] === "worktree" && args[1] === "ps") {
      const worktrees = objectRows(worktreePsResult.worktrees).map((worktree) =>
        this.worktreeAgentsOverride === null
          ? { ...worktree }
          : { ...worktree, agents: this.worktreeAgentsOverride },
      );
      const malformedRow = worktrees[0];
      if (malformedRow && this.worktreePsMalformedAgents === "missing") delete malformedRow.agents;
      else if (malformedRow && this.worktreePsMalformedAgents === "non-array") {
        malformedRow.agents = "not-an-array";
      }
      const result: JsonObject = {
        ...worktreePsResult,
        worktrees,
        truncated: this.worktreePsTruncated,
      };
      if (this.worktreePsMissingWorktrees) delete result.worktrees;
      return successResponse(worktreePsCapture, result);
    }
    if (args[0] === "agent" && args[1] === "hooks" && args[2] === "status") {
      return successResponse(hooksStatusCapture, {
        ...capturedHooksResult,
        statuses: this.hookStatuses,
      });
    }
    if (args[0] === "terminal" && args[1] === "show") {
      const handle = args[args.indexOf("--terminal") + 1] ?? "";
      if (this.staleHandles.has(handle) || !this.terminals.some((terminal) => terminal.handle === handle)) {
        return failure("terminal_handle_stale", "terminal_handle_stale");
      }
      const terminal = this.terminals.find((item) => item.handle === handle)!;
      const capturedTerminal = object(responseResult(terminalShowCapture).terminal) ?? {};
      return successResponse(terminalShowCapture, {
        ...responseResult(terminalShowCapture),
        terminal: { ...capturedTerminal, ...terminal, ...this.showFields },
      });
    }
    if (args[0] === "terminal" && args[1] === "send") {
      this.sendCalls.push({ args: [...args], timeoutMs: options.timeoutMs });
      if (this.sendFailure) {
        if (this.sendFailureAfterAccept) {
          const send = this.sendReceipt.send;
          if (typeof send === "object" && send !== null && (send as JsonObject).accepted === true) {
            this.acceptedInputWrites++;
          }
          this.afterSend?.();
        }
        return this.sendFailure;
      }
      const sendTemplateResult = responseResult(this.sendEnvelopeCapture);
      const capturedSend = object(sendTemplateResult.send) ?? {};
      const overrideSend = object(this.sendReceipt.send) ?? {};
      const send: JsonObject = {
        ...capturedSend,
        ...overrideSend,
        prompt: {
          ...(object(capturedSend.prompt) ?? {}),
          ...(object(overrideSend.prompt) ?? {}),
        },
      };
      const result = {
        ...sendTemplateResult,
        ...this.sendReceipt,
        send,
        mutation: {
          ...(object(sendTemplateResult.mutation) ?? {}),
          ...(object(this.sendReceipt.mutation) ?? {}),
        },
      };
      const accepted = send.accepted === true;
      if (accepted) this.acceptedInputWrites++;
      this.afterSend?.();
      return successResponse(this.sendEnvelopeCapture, result);
    }
    if (args[0] === "terminal" && args[1] === "read") {
      const handle = args[args.indexOf("--terminal") + 1] ?? "";
      const screen = this.screenSequence.shift() ?? this.screen;
      const result = successResponse(terminalReadCapture, {
        ...responseResult(terminalReadCapture),
        terminal: { ...screen, handle },
      });
      this.screenReadHook?.();
      return result;
    }
    throw new Error(`unexpected fake Orca command: ${args.join(" ")}`);
  }
}

function backend(runtime: FakeOrcaRuntime): OrcaBackend {
  return new OrcaBackend(runtime.bin, runtime);
}
const OMP_SESSION_ID = "9a51b84e-610c-4d9e-bb20-28d7c850c552";
const OMP_CWD = "/workspace-omp";
const OMP_TRANSCRIPT =
  `/fake-home/.omp/profiles/team/agent/sessions/2026-09-28T22-53-54-622Z_${OMP_SESSION_ID}.jsonl`;
const OMP_PANE = "omp-tab:omp-leaf";
const OMP_HANDLE = "omp-terminal";
type OmpWriterFixture = "v7-main-writer-fields.lsof" | "v7-session-dir-writer-fields.lsof";
type OmpTranscriptFixture =
  | "v4-new-session-head.jsonl"
  | "v4-first-session-final-head.jsonl"
  | "v4-session-head.jsonl";
const OMP_LSOF_DEVICE_HEX = "0x1000012";
const OMP_LSOF_DEVICE_DECIMAL = BigInt(OMP_LSOF_DEVICE_HEX).toString(10);

function capturedOmpWriter(pid: number, path: string, fixture: OmpWriterFixture): {
  output: string;
  device: string;
  inode: string;
} {
  const source = readFileSync(new URL(`./__fixtures__/orca/omp/${fixture}`, import.meta.url), "utf8").trimEnd();
  const inode = source.match(/^i(\d+)$/mu)?.[1];
  if (!inode) throw new Error(`captured OMP writer fixture has no inode: ${fixture}`);
  // The V7 raw blocks omit lsof D and stat samples; this synthetic D exercises hex normalization only.
  const fields = source
    .replace(/^tREG$/mu, `tREG\nD${OMP_LSOF_DEVICE_HEX}`)
    .replace(/^n.*$/mu, `n${path}`);
  return {
    output: `p${pid}\n${fields}`,
    device: OMP_LSOF_DEVICE_DECIMAL,
    inode,
  };
}
function capturedOmpOpener(pid: number, path: string, access: "r" | "w" = "w"): string {
  const raw = ompSingleOpenerCapture.fdOutput;
  if (typeof raw !== "string" || !raw.includes("aw")) {
    throw new Error("captured OMP opener fixture has no raw write-access block");
  }
  return raw
    .replace("<pid-V7-A>", String(pid))
    .replace(/^aw$/mu, `a${access}`)
    .replace(/^n.*$/mu, `n${path}`);
}
function replaceOmpLsofDevice(runtime: FakeOrcaRuntime, pid: number, value: string): void {
  const descriptors = runtime.descriptorOutputs.get(pid);
  if (descriptors === undefined) throw new Error(`fake OMP process has no descriptor output: ${pid}`);
  const updated = descriptors.replace(/^D.*$/mu, `D${value}`);
  if (updated === descriptors) throw new Error(`fake OMP process has no device field: ${pid}`);
  runtime.descriptorOutputs.set(pid, updated);
}
// These files preserve the first two V4 JSONL records with title/session values redacted.
function capturedOmpTranscriptHead(fixture: OmpTranscriptFixture): string {
  return readFileSync(new URL(`./__fixtures__/orca/omp/${fixture}`, import.meta.url), "utf8").replace(/\r?\n$/u, "");
}



function installOmpProcess(
  runtime: FakeOrcaRuntime,
  options: {
    pid?: number;
    command?: string;
    paneKey?: string;
    terminalHandle?: string;
    cwd?: string;
    sessionId?: string;
    path?: string;
    writerFixture?: OmpWriterFixture;
    transcriptFixture?: OmpTranscriptFixture;
  } = {},
): ProcessFixture {
  const pid = options.pid ?? 40303;
  const cwd = options.cwd ?? OMP_CWD;
  const sessionId = options.sessionId ?? OMP_SESSION_ID;
  const path = options.path ?? OMP_TRANSCRIPT;
  const process: ProcessFixture = {
    pid,
    ppid: 1,
    pgid: pid,
    tpgid: pid,
    tty: "ttys007",
    lstart: "Mon Sep 28 20:33:00 2026",
    command: options.command ?? "omp --profile team",
    paneKey: options.paneKey ?? OMP_PANE,
    terminalHandle: options.terminalHandle ?? OMP_HANDLE,
    cwd,
  };
  runtime.processes = [process];
  runtime.terminals = [
    terminalFor(process.paneKey!, process.terminalHandle!, { title: "OMP terminal" }),
  ];
  runtime.worktreeAgentsOverride = [];
  runtime.setOmpBinding(pid, path, cwd, sessionId, options.writerFixture, options.transcriptFixture);
  return process;
}


function currentRef(row: ProcessFixture = capture.process): AgentRef {
  return {
    target: `orca:${row.paneKey ?? PANE}`,
    pid: row.pid,
    processStartedAt: Date.parse(row.lstart),
  };
}

function capturedClaudeScreen(name: string): JsonObject {
  const fixture = JSON.parse(
    readFileSync(new URL(`../agents/claude/__fixtures__/${name}`, import.meta.url), "utf8"),
  ) as { terminal: JsonObject };
  return fixture.terminal;
}

function capturedProbeScreen(name: string): JsonObject {
  const terminal = object(responseResult(readJsonFixture(`./__fixtures__/orca/${name}`)).terminal);
  if (!terminal) throw new Error(`probe fixture ${name} has no terminal object`);
  return terminal;
}

function capturedOmpScreen(name: string): JsonObject {
  const fixture = JSON.parse(
    readFileSync(new URL(`../agents/omp/__fixtures__/${name}`, import.meta.url), "utf8"),
  ) as { terminal: JsonObject };
  return fixture.terminal;
}

function capturedText(screen: JsonObject): string {
  const tail = screen.tail;
  if (!Array.isArray(tail) || !tail.every((line) => typeof line === "string")) {
    throw new Error("captured Claude screen has no string tail");
  }
  return tail.join("\n");
}

function capturedQuestion(screen: JsonObject) {
  const prompt = claudeDriver.parseBlockedPane(capturedText(screen));
  if (prompt.kind !== "question") throw new Error("captured Claude screen is not a verified question");
  return prompt;
}

function submitContext(cancelled: () => boolean = () => false): SubmitContext {
  return {
    driver: claudeDriver,
    cancelled,
    transcriptGrew: () => false,
    retryLimit: 0,
    pollIntervalMs: 0,
  };
}
function assertLastWriteOrder(runtime: FakeOrcaRuntime, path: string): void {
  const commands = runtime.calls.map(({ file, args }) =>
    file === "ps" ? `ps ${args[0]}` : `${args[0]} ${args[1]}`,
  );
  assert.deepEqual(
    commands.slice(-5),
    ["terminal list", "terminal read", "ps -axww", "ps eww", "terminal send"],
    path,
  );
}

function fromTransition(snapshot: SessionTransition & { state: string }): ProcessFixture {
  return {
    ...snapshot.process,
    paneKey: snapshot.process.environment.ORCA_PANE_KEY,
    terminalHandle: snapshot.process.environment.ORCA_TERMINAL_HANDLE,
    cwd: "/scratch",
  };
}

function installTransition(runtime: FakeOrcaRuntime, snapshot: SessionTransition & { state: string }): void {
  const process = fromTransition(snapshot);
  runtime.processes = [process];
  runtime.terminals = snapshot.terminalList.terminals.map((terminal) => ({ ...terminal }));
  runtime.terminalListTruncated = snapshot.terminalList.truncated;
  runtime.worktreeAgentsOverride = [];
  runtime.setSession(process.pid, snapshot.sessionFile);
}

test("discovers the Claude process and joins terminal, worktree state, cwd, and session evidence", async () => {
  const runtime = new FakeOrcaRuntime();
  const result = await backend(runtime).list();

  assert.equal(result.complete, true);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.notices, []);
  assert.equal(result.agents.length, 1);
  const agent = result.agents[0]!;
  assert.equal(agent.ref.target, TARGET);
  assert.equal(agent.ref.pid, capture.process.pid);
  assert.equal(agent.ref.processStartedAt, Date.parse(capture.process.lstart));
  assert.equal(agent.backend, "orca");
  assert.equal(agent.agent, "claude");
  assert.equal(agent.sessionId, "<session-A>");
  assert.equal(agent.cwd, "/workspace-B");
  assert.deepEqual(agent.evidence, {
    kind: "hint",
    state: "waiting",
    waitingSince: worktreeQuestionAgent.stateStartedAt,
  });
  assert.equal(agent.pickerState, worktreeQuestionAgent.state);
  const picker = agentPickerBlocks(result, ["orca"]) as unknown as Array<{
    accessory: {
      option_groups: Array<{
        options: Array<{ text: { text: string }; value: string }>;
      }>;
    };
  }>;
  const option = picker[0]!.accessory.option_groups[0]!.options[0]!;
  assert.match(option.text.text, /^🔴 /u);
  assert.equal(option.value, TARGET);
  assert.equal(agent.terminalId, HANDLE);
  assert.deepEqual(runtime.readPaths, [SESSION_PATH(capture.process.pid)]);
  assert.ok(runtime.calls.every((call) => call.timeoutMs === 5_000));
});
test("lists OMP only with its verified transcript binding and preserves process identity", async () => {
  const runtime = new FakeOrcaRuntime();
  const process = installOmpProcess(runtime);
  const terminals = backend(runtime);
  const result = await terminals.list();

  assert.equal(result.complete, true);
  assert.deepEqual(result.notices, []);
  assert.equal(result.agents.length, 1);
  const agent = result.agents[0]!;
  assert.equal(agent.agent, "omp");
  assert.equal(agent.ref.target, `orca:${OMP_PANE}`);
  assert.equal(agent.ref.agentKind, "omp");
  assert.equal(agent.sessionId, OMP_SESSION_ID);
  assert.deepEqual(agent.transcriptIdentity, {
    path: OMP_TRANSCRIPT,
    device: "16777234",
    inode: "13090808",
  });
  assert.equal(agent.cwd, process.cwd);
  assert.equal((await terminals.get(agent.ref.target))?.agent, "omp");
  assert.equal(await terminals.sameProcess(agent.ref), true);
  assert.ok(
    runtime.calls.some(({ file, args }) => file === "lsof" && args.includes("-FftpaDin")),
    "requests lsof's hexadecimal device-number field",
  );
  runtime.statOutputs.set(OMP_TRANSCRIPT, "16777234 93002\n");
  assert.equal(await terminals.sameProcess(agent.ref), false, "same PID and pane do not excuse an inode change");
});
test("OMP lsof device numbers reject malformed and unsafe values but accept the safe limit", async () => {
  const maximumSafe = BigInt(Number.MAX_SAFE_INTEGER);
  const maximumSafeHex = `0X${maximumSafe.toString(16).toUpperCase()}`;
  const maximumSafeDevice = maximumSafe.toString(10);
  const aboveSafe = maximumSafe + 1n;
  const aboveSafeHex = `0x${aboveSafe.toString(16)}`;
  const aboveSafeDevice = aboveSafe.toString(10);

  const atLimitRuntime = new FakeOrcaRuntime();
  const atLimitProcess = installOmpProcess(atLimitRuntime);
  replaceOmpLsofDevice(atLimitRuntime, atLimitProcess.pid, maximumSafeHex);
  atLimitRuntime.statOutputs.set(OMP_TRANSCRIPT, `${maximumSafeDevice} 13090808\n`);
  const atLimit = await backend(atLimitRuntime).list();
  assert.equal(atLimit.agents.length, 1, "Number.MAX_SAFE_INTEGER remains a valid device");
  assert.equal(atLimit.agents[0]?.transcriptIdentity?.device, maximumSafeDevice);

  const invalidDevices = [
    { name: "no hex digits", value: "0x" },
    { name: "non-hex characters", value: "0x12g" },
    { name: "empty D value", value: "" },
    { name: "missing hexadecimal prefix", value: "1000012" },
    { name: "one above Number.MAX_SAFE_INTEGER", value: aboveSafeHex, statDevice: aboveSafeDevice },
  ];
  for (const invalid of invalidDevices) {
    const runtime = new FakeOrcaRuntime();
    const process = installOmpProcess(runtime);
    replaceOmpLsofDevice(runtime, process.pid, invalid.value);
    if (invalid.statDevice) runtime.statOutputs.set(OMP_TRANSCRIPT, `${invalid.statDevice} 13090808\n`);
    const result = await backend(runtime).list();
    assert.deepEqual(result.agents, [], invalid.name);
    assert.ok(result.notices.includes(OMP_RESUME_NOTICE), invalid.name);
  }
});

test("OMP binds from each captured V4 title-prefaced session header", async () => {
  const fixtures: OmpTranscriptFixture[] = [
    "v4-new-session-head.jsonl",
    "v4-first-session-final-head.jsonl",
    "v4-session-head.jsonl",
  ];
  for (const transcriptFixture of fixtures) {
    const runtime = new FakeOrcaRuntime();
    installOmpProcess(runtime, { transcriptFixture });
    const result = await backend(runtime).list();
    assert.equal(result.agents[0]?.sessionId, OMP_SESSION_ID, transcriptFixture);
  }
});

test("OMP refuses missing, malformed, and conflicting first session records", async () => {
  const capturedHead = capturedOmpTranscriptHead("v4-new-session-head.jsonl").split(/\r?\n/u);
  const [title, sessionLine] = capturedHead;
  if (!title || !sessionLine) throw new Error("captured V4 head is incomplete");
  const conflictingSession = JSON.parse(sessionLine) as JsonObject;
  conflictingSession.cwd = "/other";
  const invalidHeads: Array<[string, string]> = [
    [
      "no session record",
      `${JSON.stringify({ type: "title" })}\n${JSON.stringify({ type: "model_change" })}`,
    ],
    ["malformed prefix", `{"type":\n${capturedHead.join("\n")}`],
    [
      "first session record mismatches despite a later matching record",
      `${title}\n${JSON.stringify(conflictingSession)}\n${sessionLine}`,
    ],
  ];
  for (const [name, head] of invalidHeads) {
    const runtime = new FakeOrcaRuntime();
    installOmpProcess(runtime);
    runtime.transcriptHeads.set(OMP_TRANSCRIPT, head);
    const result = await backend(runtime).list();
    assert.deepEqual(result.agents, [], name);
    assert.ok(result.notices.includes(OMP_RESUME_NOTICE), name);
  }
});

test("native transcript head is bounded by 16 lines and 64 KiB", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cctag-omp-head-"));
  try {
    const runtime = createOrcaRuntime();
    const session = JSON.stringify({ type: "session", version: 3, id: OMP_SESSION_ID, cwd: OMP_CWD });
    const lineBoundPath = join(directory, "line-bound.jsonl");
    const firstSixteen = Array.from({ length: 16 }, () => JSON.stringify({ type: "title", v: 1 })).join("\n");
    writeFileSync(lineBoundPath, `${firstSixteen}\n${session}\n`);
    const lineBound = await runtime.readTranscriptHead(lineBoundPath);
    assert.equal((lineBound.match(/\n/gu) ?? []).length, 16);
    assert.equal(lineBound.includes('"type":"session"'), false);

    const byteBoundPath = join(directory, "byte-bound.jsonl");
    const oversizedTitle = JSON.stringify({ type: "title", pad: "x".repeat(64 * 1024) });
    writeFileSync(byteBoundPath, `${oversizedTitle}\n${session}\n`);
    const byteBound = await runtime.readTranscriptHead(byteBoundPath);
    assert.equal(Buffer.byteLength(byteBound, "utf8"), 64 * 1024);
    assert.equal(byteBound.includes('"type":"session"'), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("lists OMP from the captured V7 opener block beside Claude", async () => {
  const runtime = new FakeOrcaRuntime();
  const claude = runtime.processes[0]!;
  const claudeTerminal = runtime.terminals[0]!;
  const omp = installOmpProcess(runtime);
  runtime.processes = [claude, omp];
  runtime.terminals = [claudeTerminal, ...runtime.terminals];

  const agents = (await backend(runtime).list()).agents;
  assert.deepEqual(
    agents.map(({ agent }) => agent).sort(),
    ["claude", "omp"],
  );
  const ompAgent = agents.find(({ agent }) => agent === "omp");
  assert.ok(ompAgent);
  assert.equal(ompAgent.ref.pid, omp.pid);
  assert.equal(ompAgent.sessionId, OMP_SESSION_ID);
  assert.equal(ompAgent.transcriptIdentity?.path, OMP_TRANSCRIPT);
  assert.notEqual(agents[0]!.ref.target, agents[1]!.ref.target);
});

test("OMP discovery fails closed on missing, ambiguous, replaced, or mismatched transcript evidence", async () => {
  const invalidEvidence: Array<{
    name: string;
    mutate(runtime: FakeOrcaRuntime, process: ProcessFixture): void;
  }> = [
    {
      name: "zero writer descriptors",
      mutate: (runtime, process) => runtime.descriptorOutputs.set(process.pid, `p${process.pid}\n`),
    },
    {
      name: "missing lsof device number",
      mutate: (runtime, process) => {
        const descriptors = runtime.descriptorOutputs.get(process.pid) ?? "";
        runtime.descriptorOutputs.set(
          process.pid,
          descriptors
            .split(/\r?\n/u)
            .filter((line) => !line.startsWith("D"))
            .join("\n"),
        );
      },
    },
    {
      name: "two writer descriptors",
      mutate: (runtime, process) => {
        const secondWriter = capturedOmpWriter(
          process.pid,
          OMP_TRANSCRIPT,
          "v7-session-dir-writer-fields.lsof",
        );
        runtime.descriptorOutputs.set(
          process.pid,
          `${runtime.descriptorOutputs.get(process.pid)}\n${secondWriter.output}`,
        );
      },
    },
    {
      name: "device/inode mismatch",
      mutate: (runtime) => runtime.statOutputs.set(OMP_TRANSCRIPT, "16777234 93002\n"),
    },
    {
      name: "another process writes the transcript",
      mutate: (runtime, process) =>
        runtime.openerOutputs.set(
          OMP_TRANSCRIPT,
          `${capturedOmpOpener(process.pid, OMP_TRANSCRIPT)}\n${capturedOmpOpener(49999, OMP_TRANSCRIPT)}`,
        ),
    },
    {
      name: "session id mismatch",
      mutate: (runtime) =>
        runtime.transcriptHeads.set(
          OMP_TRANSCRIPT,
          JSON.stringify({ type: "session", version: 3, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", cwd: OMP_CWD }),
        ),
    },
    {
      name: "session cwd mismatch",
      mutate: (runtime) =>
        runtime.transcriptHeads.set(
          OMP_TRANSCRIPT,
          JSON.stringify({ type: "session", version: 3, id: OMP_SESSION_ID, cwd: "/other" }),
        ),
    },
    {
      name: "session record is not v3",
      mutate: (runtime) =>
        runtime.transcriptHeads.set(
          OMP_TRANSCRIPT,
          JSON.stringify({ type: "session", version: 2, id: OMP_SESSION_ID, cwd: OMP_CWD }),
        ),
    },
  ];

  for (const evidence of invalidEvidence) {
    const runtime = new FakeOrcaRuntime();
    const process = installOmpProcess(runtime);
    evidence.mutate(runtime, process);
    const result = await backend(runtime).list();
    assert.deepEqual(result.agents, [], evidence.name);
    assert.ok(result.notices.includes(OMP_RESUME_NOTICE), evidence.name);
  }
});

test("OMP accepts read-only transcript observers and enforces explicit session directory boundaries", async () => {
  const observerRuntime = new FakeOrcaRuntime();
  const observer = installOmpProcess(observerRuntime);
  observerRuntime.openerOutputs.set(
    OMP_TRANSCRIPT,
    `${capturedOmpOpener(observer.pid, OMP_TRANSCRIPT)}\n${capturedOmpOpener(49999, OMP_TRANSCRIPT, "r")}`,
  );
  assert.equal((await backend(observerRuntime).list()).agents[0]?.agent, "omp");

  const directory = "/tmp/cctag-omp-sessions";
  const filename = `2026-09-28T22-53-54-622Z_${OMP_SESSION_ID}.jsonl`;
  const path = `${directory}/${filename}`;
  const explicitRuntime = new FakeOrcaRuntime();
  installOmpProcess(explicitRuntime, {
    command: `omp --session-dir ${directory}`,
    path,
    writerFixture: "v7-session-dir-writer-fields.lsof",
  });
  assert.equal((await backend(explicitRuntime).list()).agents[0]?.agent, "omp");

  const nestedProfileRuntime = new FakeOrcaRuntime();
  const nestedProfilePath = `${HOME}/.omp/profiles/team/agent/sessions/nested/${filename}`;
  installOmpProcess(nestedProfileRuntime, { path: nestedProfilePath });
  assert.equal((await backend(nestedProfileRuntime).list()).agents[0]?.agent, "omp");

  const nestedExplicitRuntime = new FakeOrcaRuntime();
  const nestedExplicitPath = `${directory}/nested/${filename}`;
  installOmpProcess(nestedExplicitRuntime, {
    command: `omp --session-dir ${directory}`,
    path: nestedExplicitPath,
    writerFixture: "v7-session-dir-writer-fields.lsof",
  });
  const nestedExplicit = await backend(nestedExplicitRuntime).list();
  assert.deepEqual(nestedExplicit.agents, []);
  assert.ok(nestedExplicit.notices.includes(OMP_RESUME_NOTICE));
});

test("OMP discovery refuses unknown session configuration and PI_CODING_AGENT_DIR", async () => {
  const unknownRuntime = new FakeOrcaRuntime();
  installOmpProcess(unknownRuntime, { command: "omp" });
  const unknown = await backend(unknownRuntime).list();
  assert.deepEqual(unknown.agents, []);
  assert.ok(unknown.notices.includes(OMP_RESUME_NOTICE));

  const piRuntime = new FakeOrcaRuntime();
  const process = installOmpProcess(piRuntime);
  process.piCodingAgentDir = "";
  const pi = await backend(piRuntime).list();
  assert.deepEqual(pi.agents, []);
  assert.ok(pi.notices.includes(OMP_RESUME_NOTICE));
});

test("same-tty foreground Claude/OMP nesting is rejected in both directions", async () => {
  for (const [parentKind, childKind] of [
    ["claude", "omp"],
    ["omp", "claude"],
  ] as const) {
    const runtime = new FakeOrcaRuntime();
    const parent =
      parentKind === "omp"
        ? installOmpProcess(runtime)
        : runtime.processes[0]!;
    const terminals = backend(runtime);
    const owner = (await terminals.list()).agents.find(({ agent }) => agent === parentKind);
    assert.ok(owner, `${parentKind} parent is discoverable before nesting`);
    const childPid = 41313;
    const child: ProcessFixture = {
      ...parent,
      pid: childPid,
      ppid: parent.pid,
      pgid: childPid,
      tpgid: childPid,
      lstart: "Mon Sep 28 20:44:00 2026",
      command: childKind === "omp" ? "omp --profile team" : capture.process.command,
    };
    runtime.processes = [parent, child];

    assert.deepEqual((await terminals.list()).agents, [], `${parentKind} containing ${childKind}`);
    assert.equal(await terminals.sameProcess(owner.ref), false, `${parentKind} containing ${childKind}`);
  }
});

test("OMP submits use one exact verified write and keep all answer channels terminal-only", async () => {
  for (const scenario of [
    { stages: ["input_accepted", "turn_started"], expected: { status: "started", draftStashed: false } },
    { stages: ["input_accepted"], expected: { status: "accepted", draftStashed: false } },
  ] as const) {
    const runtime = new FakeOrcaRuntime();
    const process = installOmpProcess(runtime);
    const target = `orca:${process.paneKey}`;
    runtime.screen = capturedOmpScreen("idle.screen.json");
    runtime.sendReceipt = withSendStages(capturedOmpSendResult, scenario.stages);
    const terminals = backend(runtime);
    const agent = await terminals.get(target);
    assert.ok(agent);
    assert.equal(agent.agent, "omp");

    const order: string[] = [];
    const sameProcess = terminals.sameProcess.bind(terminals);
    terminals.sameProcess = async (ref) => {
      const current = await sameProcess(ref);
      order.push("sameProcess");
      return current;
    };
    const execFile = runtime.execFile.bind(runtime);
    runtime.execFile = async (file, args, options) => {
      if (file === runtime.bin && args[0] === "terminal" && args[1] === "send") order.push("send");
      return execFile(file, args, options);
    };

    assert.deepEqual(
      await terminals.submit(agent.ref, "hello", { ...submitContext(), driver: ompDriver }),
      scenario.expected,
    );
    assert.deepEqual(order.slice(-2), ["sameProcess", "send"], "fresh process verification immediately precedes the one write");
    assert.equal(runtime.sendCalls.length, 1);
    assert.equal(runtime.acceptedInputWrites, 1);
    assert.equal(runtime.sendCalls[0]!.timeoutMs, 25_000);
    assert.deepEqual(runtime.sendCalls[0]!.args, [
      "terminal",
      "send",
      "--terminal",
      OMP_HANDLE,
      "--text",
      "hello",
      "--enter",
      "--wait-submit",
      "15",
      "--json",
    ]);

    const callsBeforeAnswer = runtime.calls.length;
    assert.throws(() => terminals.openAnswer(agent.ref, {} as never), ExpectationLost);
    assert.throws(() => terminals.openBlind(agent.ref, { driver: ompDriver } as never), ExpectationLost);
    assert.throws(() => terminals.openComposer(agent.ref, ompDriver), ExpectationLost);
    assert.throws(() => terminals.openComposer(currentRef(), ompDriver), ExpectationLost);
    assert.equal(runtime.calls.length, callsBeforeAnswer, "answer, blind, and composer channels do not inspect or write");
  }

  const ambiguous = new FakeOrcaRuntime();
  const process = installOmpProcess(ambiguous);
  const target = `orca:${process.paneKey}`;
  ambiguous.screen = capturedOmpScreen("idle.screen.json");
  ambiguous.sendFailure = { stdout: "", stderr: "transport failed", exitCode: 1, error: "transport failed" };
  ambiguous.sendFailureAfterAccept = true;
  const terminals = backend(ambiguous);
  const agent = await terminals.get(target);
  assert.ok(agent);
  await assert.rejects(
    terminals.submit(agent.ref, "hello", { ...submitContext(), driver: ompDriver }),
    WriteOutcomeUnknown,
  );
  assert.equal(ambiguous.acceptedInputWrites, 1, "the failed response may follow accepted input");
  assert.equal(ambiguous.sendCalls.length, 1, "an ambiguous OMP write is never retried");
});

test("OMP submit maps Orca prompt gates and unaccepted receipts without retrying", async () => {
  const gated = new FakeOrcaRuntime();
  const gatedProcess = installOmpProcess(gated);
  const gatedTarget = `orca:${gatedProcess.paneKey}`;
  gated.screen = capturedOmpScreen("idle.screen.json");
  gated.sendFailure = failure("agent_prompt_blocked", "prompt is blocking");
  const gatedTerminals = backend(gated);
  const gatedAgent = await gatedTerminals.get(gatedTarget);
  assert.ok(gatedAgent);
  await assert.rejects(
    gatedTerminals.submit(gatedAgent.ref, "hello", { ...submitContext(), driver: ompDriver }),
    (error: unknown) => error instanceof SubmitRefused && error.reason === "gate",
  );
  assert.equal(gated.sendCalls.length, 1);

  const unaccepted = new FakeOrcaRuntime();
  const unacceptedProcess = installOmpProcess(unaccepted);
  const unacceptedTarget = `orca:${unacceptedProcess.paneKey}`;
  unaccepted.screen = capturedOmpScreen("idle.screen.json");
  unaccepted.sendReceipt = withSendStages(capturedOmpSendResult, [], false);
  const unacceptedTerminals = backend(unaccepted);
  const unacceptedAgent = await unacceptedTerminals.get(unacceptedTarget);
  assert.ok(unacceptedAgent);
  await assert.rejects(
    unacceptedTerminals.submit(unacceptedAgent.ref, "hello", { ...submitContext(), driver: ompDriver }),
    WriteOutcomeUnknown,
  );
  assert.equal(unaccepted.sendCalls.length, 1);
  assert.equal(unaccepted.acceptedInputWrites, 0);
});

test("OMP working, waiting, draft, and incomplete screens never send input", async () => {
  const cases: Array<{ name: string; screen: JsonObject; reason: SubmitRefused["reason"] }> = [
    { name: "working", screen: capturedOmpScreen("working.screen.json"), reason: "not-idle" },
    { name: "waiting", screen: capturedOmpScreen("ask-open.screen.json"), reason: "not-idle" },
    { name: "draft", screen: capturedOmpScreen("draft.screen.json"), reason: "not-idle" },
    {
      name: "incomplete",
      // Synthetic incomplete variant derived from the raw idle.screen.json capture.
      screen: { ...capturedOmpScreen("idle.screen.json"), limited: true },
      reason: "incomplete-screen",
    },
  ];

  for (const scenario of cases) {
    const runtime = new FakeOrcaRuntime();
    const process = installOmpProcess(runtime);
    const target = `orca:${process.paneKey}`;
    runtime.screen = scenario.screen;
    const terminals = backend(runtime);
    const agent = await terminals.get(target);
    assert.ok(agent, scenario.name);
    await assert.rejects(
      terminals.submit(agent.ref, "hello", { ...submitContext(), driver: ompDriver }),
      (error: unknown) => error instanceof SubmitRefused && error.reason === scenario.reason,
      scenario.name,
    );
    assert.equal(runtime.sendCalls.length, 0, scenario.name);
    assert.equal(runtime.acceptedInputWrites, 0, scenario.name);
  }
});

test("OMP submit refuses when the transcript-bound process changes after the complete screen read", async () => {
  const runtime = new FakeOrcaRuntime();
  const process = installOmpProcess(runtime);
  const target = `orca:${process.paneKey}`;
  runtime.screen = capturedOmpScreen("idle.screen.json");
  const terminals = backend(runtime);
  const agent = await terminals.get(target);
  assert.ok(agent);
  runtime.screenReadHook = () => {
    runtime.processes = [{ ...process, lstart: "Mon Sep 28 20:44:00 2026" }];
  };

  await assert.rejects(
    terminals.submit(agent.ref, "hello", { ...submitContext(), driver: ompDriver }),
    (error: unknown) => error instanceof SubmitRefused && error.reason === "agent-changed",
  );
  assert.equal(runtime.sendCalls.length, 0);
});

test("recognizes Claude Code running through its Node entrypoint", async () => {
  const runtime = new FakeOrcaRuntime();
  runtime.processes = [
    {
      ...runtime.processes[0]!,
      command: "/opt/homebrew/bin/node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js",
    },
  ];

  const result = await backend(runtime).list();
  assert.equal(result.agents.length, 1);
  assert.equal(result.agents[0]!.agent, "claude");
});

test("truncated terminal lists make discovery incomplete", async () => {
  const runtime = new FakeOrcaRuntime();
  runtime.terminalListTruncated = true;
  const result = await backend(runtime).list();
  assert.equal(result.complete, false);
});

test("a process exiting between ps and lsof does not fail the lookup of another pane", async () => {
  const runtime = new FakeOrcaRuntime();
  const exited: ProcessFixture = {
    pid: 40010,
    ppid: 1,
    pgid: 40010,
    tpgid: 40010,
    tty: "ttys030",
    lstart: "Mon Sep 28 17:07:36 2026",
    command: "claude",
    paneKey: "exited-pane",
    terminalHandle: "exited-terminal",
    cwd: "/exited",
  };
  runtime.processes = [...runtime.processes, exited];
  runtime.exitedAfterPs.add(exited.pid);
  const terminals = backend(runtime);

  const agent = await terminals.get(TARGET);
  assert.equal(agent?.cwd, "/workspace-B");
  const listed = await terminals.list();
  assert.deepEqual(listed.failures, []);
  assert.deepEqual(
    listed.agents.map((row) => row.ref.target),
    [TARGET],
  );
});

test("lsof explaining a failure on stderr still makes the backend unavailable", async () => {
  const runtime = new FakeOrcaRuntime();
  runtime.lsofStderr = "lsof: unknown option: x\nlsof 4.91\n usage: [-?abhKlnNoOPRtUvVX] ...";
  await assert.rejects(backend(runtime).get(TARGET), BackendUnavailable);
});

test("the native runtime reports exit statuses as the process gave them, and none for a killed one", async () => {
  // Not the fake: the fake cannot vouch for what Node reports.
  const runtime = createOrcaRuntime();
  const exited = await runtime.execFile("sh", ["-c", "exit 1"], { timeoutMs: 5_000 });
  assert.equal(exited.exitCode, 1);
  assert.equal(exited.stderr, "");
  const killed = await runtime.execFile("sleep", ["5"], { timeoutMs: 50 });
  assert.equal(killed.exitCode, -1);
  assert.equal(killed.stderr, "");
});

test("get and exists reject missing targets from incomplete terminal lists", async () => {
  const runtime = new FakeOrcaRuntime();
  runtime.terminals = [];
  assert.ok(runtime.processes.some((process) => process.paneKey === PANE), "the probe keeps a live Orca process");
  const terminals = backend(runtime);

  for (const truncated of [true, undefined, "false"]) {
    runtime.terminalListTruncated = truncated;
    assert.equal((await terminals.list()).complete, false, "incomplete discovery must remain marked incomplete");
    await assert.rejects(terminals.get(TARGET), BackendUnavailable);
    await assert.rejects(terminals.exists(TARGET), BackendUnavailable);
  }

  runtime.terminalListTruncated = false;
  assert.equal(await terminals.get(TARGET), null);
  assert.equal(await terminals.exists(TARGET), false);
});

test("missing or malformed terminal-list truncated flags make discovery incomplete", async () => {
  const runtime = new FakeOrcaRuntime();
  runtime.terminalListTruncated = undefined;
  assert.equal((await backend(runtime).list()).complete, false);

  runtime.terminalListTruncated = "false";
  assert.equal((await backend(runtime).list()).complete, false);
});
test("a missing worktrees array is a BackendUnavailable result", async () => {
  const runtime = new FakeOrcaRuntime();
  runtime.worktreePsMissingWorktrees = true;
  const terminals = backend(runtime);

  const listed = await terminals.list();
  assert.equal(listed.complete, false);
  assert.ok(listed.failures.some(({ reason }) => reason.includes("no worktrees array")));
  await assert.rejects(
    terminals.get(TARGET),
    (error: unknown) => error instanceof BackendUnavailable && error.message.includes("no worktrees array"),
  );
});
test("malformed worktree agents and truncated fields are BackendUnavailable", async () => {
  const cases = [
    {
      name: "worktree row without agents",
      configure: (runtime: FakeOrcaRuntime) => {
        runtime.worktreePsMalformedAgents = "missing";
      },
    },
    {
      name: "worktree row with non-array agents",
      configure: (runtime: FakeOrcaRuntime) => {
        runtime.worktreePsMalformedAgents = "non-array";
      },
    },
    {
      name: "missing truncated flag",
      configure: (runtime: FakeOrcaRuntime) => {
        runtime.worktreePsTruncated = undefined;
      },
    },
    {
      name: "non-boolean truncated flag",
      configure: (runtime: FakeOrcaRuntime) => {
        runtime.worktreePsTruncated = "false";
      },
    },
  ];
  for (const scenario of cases) {
    const runtime = new FakeOrcaRuntime();
    scenario.configure(runtime);
    const terminals = backend(runtime);
    assert.equal((await terminals.list()).complete, false, scenario.name);
    await assert.rejects(terminals.get(TARGET), BackendUnavailable, scenario.name);
  }
});


test("screen reads are full-frame and reject non-positive line counts", async () => {
  const runtime = new FakeOrcaRuntime();
  const terminals = backend(runtime);

  await assert.rejects(terminals.read(TARGET, 0, "screen"), /lines must be a positive integer/);
  assert.equal(runtime.calls.length, 0, "invalid line counts must be rejected before any CLI call");

  const complete = await terminals.read(TARGET, 40, "screen");
  assert.equal(complete.complete, true);
  const readCall = runtime.calls.find(({ args }) => args[0] === "terminal" && args[1] === "read");
  assert.ok(readCall, "the probe must build a terminal read command");
  assert.deepEqual(readCall.args.slice(0, 5), ["terminal", "read", "--terminal", HANDLE, "--screen"]);
  assert.equal(readCall.args.includes("--limit"), false, "screen reads must not send a zero or truncating limit");

  // Synthetic completeness variants of the raw terminalReadCapture.
  runtime.screen = { ...runtime.screen, limited: true };
  assert.equal((await terminals.read(TARGET, 40, "history")).complete, false);
  // Raw reads from long-lived terminals (rows masked): a stream-buffer `truncated`
  // alone does not make a screen incomplete; `limited` still does.
  runtime.screen = capturedProbeScreen("screen-read-long-lived-truncated.json");
  assert.equal((await terminals.read(TARGET, 40, "screen")).complete, true);
  runtime.screen = capturedProbeScreen("screen-read-omp-limited-truncated.json");
  assert.equal((await terminals.read(TARGET, 40, "screen")).complete, false);
  runtime.screen = { ...capturedProbeScreen("screen-read-long-lived-truncated.json"), source: "screen-unavailable" };
  assert.equal((await terminals.read(TARGET, 40, "screen")).complete, false);
  // Synthetic malformed screen records; these are not raw captured CLI outputs.
  runtime.screen = { source: "screen", status: "running", tail: ["shortened output"] };
  assert.equal((await terminals.read(TARGET, 40, "screen")).complete, false);
  runtime.screen = { source: "screen", status: "running", limited: false, truncated: false, tail: ["valid", 42] };
  assert.equal((await terminals.read(TARGET, 40, "screen")).complete, false);
});

test("Codex and no-tty Claude daemon processes are never listed", async () => {
  const runtime = new FakeOrcaRuntime();
  const claudeDaemon: ProcessFixture = {
    pid: 40001,
    ppid: 1,
    pgid: 40001,
    tpgid: 0,
    tty: "??",
    lstart: "Mon Sep 28 17:05:36 2026",
    command: "claude",
    paneKey: "daemon-pane",
    terminalHandle: "daemon-terminal",
    cwd: "/daemon",
  };
  const codex: ProcessFixture = {
    pid: 40002,
    ppid: 1,
    pgid: 40002,
    tpgid: 40002,
    tty: "ttys020",
    lstart: "Mon Sep 28 17:06:36 2026",
    command: "codex",
    paneKey: "codex-pane",
    terminalHandle: "codex-terminal",
    cwd: "/codex",
  };
  runtime.processes = [claudeDaemon, codex];
  runtime.terminals = [terminalFor("daemon-pane", "daemon-terminal"), terminalFor("codex-pane", "codex-terminal")];
  runtime.worktreeAgentsOverride = [];

  const result = await backend(runtime).list();
  assert.deepEqual(result.agents, []);
  assert.ok(result.notices.includes("Orca 上の Codex は未対応です"));
});

test("does not promote a Codex child of Claude to an Orca agent", async () => {
  const runtime = new FakeOrcaRuntime();
  const parent = runtime.processes[0]!;
  const codex: ProcessFixture = {
    ...parent,
    pid: 90006,
    ppid: parent.pid,
    pgid: 90006,
    tpgid: 0,
    tty: "??",
    lstart: "Mon Sep 28 20:31:00 2026",
    command: "codex",
    paneKey: "codex-tab:codex-leaf",
    terminalHandle: "codex-terminal",
    cwd: "/codex",
  };
  runtime.processes = [parent, codex];

  const result = await backend(runtime).list();
  assert.equal(result.agents.length, 1);
  assert.equal(result.agents[0]!.agent, "claude");
  assert.ok(result.notices.includes("Orca 上の Codex は未対応です"));
});

test("a same-tty foreground agent child blocks both discovery and sameProcess", async () => {
  const runtime = new FakeOrcaRuntime();
  const parent = runtime.processes[0]!;
  const terminals = backend(runtime);
  const initiallyListed = await terminals.list();
  assert.equal(initiallyListed.agents.length, 1);
  const ref = initiallyListed.agents[0]!.ref;
  assert.equal(await terminals.sameProcess(ref), true);

  const child: ProcessFixture = {
    ...parent,
    pid: 90001,
    ppid: parent.pid,
    lstart: "Mon Sep 28 20:30:00 2026",
    command: "claude",
  };
  runtime.processes = [parent, child];
  assert.deepEqual((await terminals.list()).agents, []);
  assert.equal(await terminals.sameProcess(ref), false);
  assert.equal(await terminals.get(TARGET), null);
});
test("a same-tty foreground non-agent child does not hide Claude", async () => {
  const runtime = new FakeOrcaRuntime();
  const parent = runtime.processes[0]!;
  const terminals = backend(runtime);
  const ref = currentRef(parent);
  const child: ProcessFixture = {
    ...parent,
    pid: 90006,
    ppid: parent.pid,
    lstart: "Mon Sep 28 20:30:30 2026",
    command: "slack-mcp-server",
  };
  runtime.processes = [parent, child];

  const listed = await terminals.list();
  assert.equal(listed.agents.length, 1);
  assert.equal(listed.agents[0]!.ref.pid, parent.pid);
  assert.equal(await terminals.sameProcess(ref), true);
});


test("finds a foreground Claude descendant through a non-agent shell process", async () => {
  const runtime = new FakeOrcaRuntime();
  const parent = runtime.processes[0]!;
  const terminals = backend(runtime);
  const ref = currentRef(parent);
  const shell: ProcessFixture = {
    ...parent,
    pid: 90004,
    ppid: parent.pid,
    pgid: 90004,
    tpgid: parent.tpgid,
    command: "bash -lc claude",
  };
  const child: ProcessFixture = {
    ...parent,
    pid: 90005,
    ppid: shell.pid,
    pgid: 90005,
    tpgid: 90005,
    lstart: "Mon Sep 28 20:32:00 2026",
    command: "claude",
    paneKey: "other-tab:other-leaf",
    terminalHandle: "missing-child",
    cwd: "/other",
  };
  runtime.processes = [parent, shell, child];

  assert.deepEqual((await terminals.list()).agents, []);
  assert.equal(await terminals.sameProcess(ref), false);
});

test("a no-tty Bash child does not block its foreground parent", async () => {
  const runtime = new FakeOrcaRuntime();
  const parent = runtime.processes[0]!;
  const child: ProcessFixture = {
    ...parent,
    pid: 90002,
    ppid: parent.pid,
    pgid: 90002,
    tpgid: 0,
    tty: "??",
    lstart: "Mon Sep 28 20:30:00 2026",
    command: "bash -lc 'claude -p'",
  };
  runtime.processes = [parent, child];
  const terminals = backend(runtime);
  const listed = await terminals.list();
  assert.equal(listed.agents.length, 1);
  assert.equal(await terminals.sameProcess(listed.agents[0]!.ref), true);
});

test("multiple unrelated candidates in one pane remain unresolved", async () => {
  const runtime = new FakeOrcaRuntime();
  const first = runtime.processes[0]!;
  const second: ProcessFixture = {
    ...first,
    pid: 90003,
    ppid: 1,
    lstart: "Mon Sep 28 20:31:00 2026",
  };
  runtime.processes = [first, second];
  assert.deepEqual((await backend(runtime).list()).agents, []);
});

test("sameProcess rejects PID reuse and an Orca pane-key mismatch", async () => {
  const runtime = new FakeOrcaRuntime();
  const terminals = backend(runtime);
  const ref = currentRef(runtime.processes[0]);

  runtime.processes = [{ ...runtime.processes[0]!, lstart: "Mon Sep 28 21:00:00 2026" }];
  assert.equal(await terminals.sameProcess(ref), false);

  runtime.processes = [{ ...runtime.processes[0]!, lstart: capture.process.lstart, paneKey: "another-pane" }];
  assert.equal(await terminals.sameProcess(ref), false);
});

test("orphaned terminal handles resolve through the shared pane resolver", async () => {
  const runtime = new FakeOrcaRuntime();
  runtime.terminals = [
    terminalFor(PANE, HANDLE, {
      tabId: "pty:orphan",
      leafId: "pty:orphan",
      orphaned: true,
    }),
  ];
  const terminals = backend(runtime);

  const listed = await terminals.list();
  assert.equal(listed.agents.length, 1);
  assert.equal(listed.agents[0]!.terminalId, HANDLE);
  assert.equal((await terminals.get(TARGET))?.terminalId, HANDLE);
  assert.equal(await terminals.exists(TARGET), true);
  assert.equal((await terminals.read(TARGET, 40, "screen")).complete, true);
});

test("an inherited handle cannot bind a different ordinary pane", async () => {
  const runtime = new FakeOrcaRuntime();
  runtime.processes = [
    { ...runtime.processes[0]!, paneKey: "tab-one:leaf-one", terminalHandle: "handle-other" },
  ];
  runtime.terminals = [terminalFor("tab-other:leaf-other", "handle-other")];
  const terminals = backend(runtime);
  const target = "orca:tab-one:leaf-one";

  assert.deepEqual((await terminals.list()).agents, []);
  assert.equal(await terminals.get(target), null);
  assert.equal(await terminals.exists(target), false);
  await assert.rejects(terminals.read(target, 40, "screen"), UnknownTarget);
  assert.equal(
    runtime.calls.some(({ args }) => args[0] === "terminal" && args[1] === "read"),
    false,
  );

  const otherPane = {
    ...runtime.processes[0]!,
    pid: 40103,
    ppid: 1,
    pgid: 40103,
    tpgid: 40103,
    tty: "ttys103",
    paneKey: "tab-other:leaf-other",
    terminalHandle: "handle-other-pane",
    cwd: "/other",
  };
  runtime.processes = [...runtime.processes, otherPane];
  runtime.terminals = [terminalFor("tab-other:leaf-other", "handle-other", { orphaned: true })];
  const orphanedOrdinary = backend(runtime);
  assert.deepEqual((await orphanedOrdinary.list()).agents, []);
  assert.equal(await orphanedOrdinary.get(target), null);
  assert.equal(await orphanedOrdinary.exists(target), false);
  await assert.rejects(orphanedOrdinary.read(target, 40, "screen"), UnknownTarget);
});

test("direct pane matches win when two process environment handles are swapped", async () => {
  const runtime = new FakeOrcaRuntime();
  const original = runtime.processes[0]!;
  const first: ProcessFixture = {
    ...original,
    pid: 40101,
    ppid: 1,
    pgid: 40101,
    tpgid: 40101,
    tty: "ttys101",
    paneKey: "tab-one:leaf-one",
    terminalHandle: "handle-two",
    cwd: "/workspace-one",
  };
  const second: ProcessFixture = {
    ...original,
    pid: 40102,
    ppid: 1,
    pgid: 40102,
    tpgid: 40102,
    tty: "ttys102",
    paneKey: "tab-two:leaf-two",
    terminalHandle: "handle-one",
    cwd: "/workspace-two",
  };
  runtime.processes = [first, second];
  runtime.terminals = [
    terminalFor(first.paneKey!, "handle-one"),
    terminalFor(second.paneKey!, "handle-two"),
  ];
  runtime.setSession(first.pid, { sessionId: "<session-one>" });
  runtime.setSession(second.pid, { sessionId: "<session-two>" });
  const terminals = backend(runtime);
  const firstTarget = `orca:${first.paneKey}`;
  const secondTarget = `orca:${second.paneKey}`;

  const listed = await terminals.list();
  assert.equal(listed.agents.find((agent) => agent.ref.target === firstTarget)?.terminalId, "handle-one");
  assert.equal(listed.agents.find((agent) => agent.ref.target === secondTarget)?.terminalId, "handle-two");
  assert.equal((await terminals.get(firstTarget))?.terminalId, "handle-one");
  assert.equal((await terminals.get(secondTarget))?.terminalId, "handle-two");
  assert.equal(await terminals.exists(firstTarget), true);
  await terminals.read(firstTarget, 40, "screen");
  const readCalls = runtime.calls.filter(({ args }) => args[0] === "terminal" && args[1] === "read");
  assert.equal(readCalls.length, 1);
  assert.equal(readCalls[0]!.args[3], "handle-one");
});

test("stale and exited terminals are not returned or considered live", async () => {
  const runtime = new FakeOrcaRuntime();
  runtime.staleHandles.add(HANDLE);
  const terminals = backend(runtime);
  assert.equal(await terminals.get(TARGET), null);
  assert.equal(await terminals.exists(TARGET), false);

  runtime.staleHandles.clear();
  runtime.terminals = runtime.terminals.map((terminal) => ({ ...terminal, writable: false, exitCause: "process exited" }));
  assert.equal(await terminals.get(TARGET), null);
  assert.equal(await terminals.exists(TARGET), false);
});


test("synthetic Claude resume and clear states update session identity without changing sameProcess policy", async () => {
  const runtime = new FakeOrcaRuntime();
  const beforeResume = transitions.snapshots.find((snapshot) => snapshot.state === "before-resume")!;
  const resumed = transitions.snapshots.find((snapshot) => snapshot.state === "after-resume-same-session")!;
  const cleared = transitions.snapshots.find((snapshot) => snapshot.state === "after-clear-new-session")!;
  const terminals = backend(runtime);

  installTransition(runtime, beforeResume);
  const first = await terminals.get(`orca:${beforeResume.process.environment.ORCA_PANE_KEY}`);
  assert.equal(first?.sessionId, beforeResume.sessionFile.sessionId);

  installTransition(runtime, resumed);
  const resumedAgent = await terminals.get(`orca:${resumed.process.environment.ORCA_PANE_KEY}`);
  assert.equal(resumedAgent?.sessionId, resumed.sessionFile.sessionId);
  assert.equal(await terminals.sameProcess(first!.ref), false);

  installTransition(runtime, cleared);
  const clearedAgent = await terminals.get(`orca:${cleared.process.environment.ORCA_PANE_KEY}`);
  assert.equal(clearedAgent?.sessionId, cleared.sessionFile.sessionId);
  assert.equal(await terminals.sameProcess(resumedAgent!.ref), true);
});

test("unreadable Claude session files skip the agent with a notice", async () => {
  const runtime = new FakeOrcaRuntime();
  runtime.sessionFiles.clear();
  const result = await backend(runtime).list();
  assert.deepEqual(result.agents, []);
  assert.ok(result.notices.some((notice) => notice.includes("セッションを特定できないため接続できません")));
});

test("missing Claude hooks produce a state-availability notice", async () => {
  const runtime = new FakeOrcaRuntime();
  runtime.hookStatuses = [{ agent: "claude", state: "missing" }];
  const result = await backend(runtime).list();
  assert.ok(result.notices.some((notice) => notice.includes("Claude hooks are not installed")));
});

test("runtime_unavailable becomes BackendUnavailable and an incomplete list", async () => {
  const runtime = new FakeOrcaRuntime();
  runtime.terminalListFailure = true;
  const terminals = backend(runtime);
  const listed = await terminals.list();
  assert.equal(listed.complete, false);
  assert.equal(listed.agents.length, 0);
  assert.ok(listed.failures.some((failure) => failure.backend === "orca"));
  await assert.rejects(terminals.get(TARGET), BackendUnavailable);
  await assert.rejects(terminals.exists(TARGET), BackendUnavailable);
  await assert.rejects(terminals.read(TARGET, 40, "screen"), BackendUnavailable);
});

test("Orca submit refuses all five unsafe outcomes without accepted input", async () => {
  const idle = () => capturedClaudeScreen("idle-composer.screen.json");
  const cases: Array<{
    reason: SubmitRefused["reason"];
    sendAttempts: number;
    prepare(runtime: FakeOrcaRuntime): AgentRef;
  }> = [
    {
      reason: "agent-changed",
      sendAttempts: 0,
      prepare: () => {
        const ref = currentRef();
        return { ...ref, processStartedAt: (ref.processStartedAt ?? 0) + 1 };
      },
    },
    {
      reason: "incomplete-screen",
      sendAttempts: 0,
      prepare: (runtime) => {
        // Synthetic limited-screen variant derived from idle-composer.screen.json.
        runtime.screen = { ...idle(), limited: true };
        return currentRef();
      },
    },
    {
      reason: "not-idle",
      sendAttempts: 0,
      prepare: (runtime) => {
        runtime.screen = capturedClaudeScreen("ask-user-question-multiselect-before-down.screen.json");
        return currentRef();
      },
    },
    {
      reason: "draft",
      sendAttempts: 0,
      prepare: (runtime) => {
        // Synthetic draft overlay derived from idle-composer.screen.json.
        runtime.screen = { ...idle(), draft: "unsent draft" };
        return currentRef();
      },
    },
    {
      reason: "gate",
      sendAttempts: 1,
      prepare: (runtime) => {
        runtime.sendFailure = failure("agent_prompt_blocked", "prompt is blocking");
        return currentRef();
      },
    },
  ];

  for (const testCase of cases) {
    const runtime = new FakeOrcaRuntime();
    runtime.screen = idle();
    const ref = testCase.prepare(runtime);
    const context =
      testCase.reason === "draft" ? { ...submitContext(), driver: ompDriver } : submitContext();
    await assert.rejects(
      backend(runtime).submit(ref, "hello", context),
      (error: unknown) => error instanceof SubmitRefused && error.reason === testCase.reason,
    );
    assert.equal(runtime.sendCalls.length, testCase.sendAttempts, testCase.reason);
    assert.equal(runtime.acceptedInputWrites, 0, testCase.reason);
  }
});

test("Orca submit separates started and accepted receipts and never resends ambiguity", async () => {
  for (const scenario of [
    {
      stages: ["input_accepted", "turn_started"],
      expected: { status: "started", draftStashed: false },
    },
    {
      stages: ["input_accepted"],
      expected: { status: "accepted", draftStashed: false },
    },
  ] as const) {
    const runtime = new FakeOrcaRuntime();
    runtime.screen = capturedClaudeScreen("idle-composer.screen.json");
    runtime.sendReceipt = withSendStages(capturedSendResult, scenario.stages);
    assert.deepEqual(await backend(runtime).submit(currentRef(), "hello", submitContext()), scenario.expected);
    assert.equal(runtime.sendCalls.length, 1);
    assert.equal(runtime.acceptedInputWrites, 1);
    assert.equal(runtime.sendCalls[0]!.timeoutMs, 25_000);
    assert.deepEqual(runtime.sendCalls[0]!.args, [
      "terminal",
      "send",
      "--terminal",
      HANDLE,
      "--text",
      "hello",
      "--enter",
      "--wait-submit",
      "15",
      "--json",
    ]);
  }

  const runtime = new FakeOrcaRuntime();
  runtime.screen = capturedClaudeScreen("idle-composer.screen.json");
  runtime.sendFailure = { stdout: "", stderr: "transport failed", exitCode: 1, error: "transport failed" };
  await assert.rejects(
    backend(runtime).submit(currentRef(), "hello", submitContext()),
    (error: unknown) =>
      error instanceof WriteOutcomeUnknown &&
      error.message === "送信できたか確認できません。端末を確かめてください",
  );
  assert.equal(runtime.sendCalls.length, 1, "ambiguous submission must not be resent");
  assert.equal(runtime.acceptedInputWrites, 0);
});

test("Orca probes and removes a suggestion before submitting", async () => {
  const runtime = new FakeOrcaRuntime();
  const suggestion = capturedProbeScreen("p4-10-suggestion.json");
  const withProbe = capturedProbeScreen("p4-11-suggestion-plus-x.json");
  const restored = capturedProbeScreen("p4-12-suggestion-after-bs.json");
  runtime.screen = restored;
  runtime.screenSequence = [
    suggestion,
    suggestion,
    withProbe,
    withProbe,
    withProbe,
    restored,
    restored,
    restored,
  ];
  runtime.sendReceipt = withSendStages(capturedSendResult, ["input_accepted"]);

  const result = await backend(runtime).submit(currentRef(), "hello", submitContext());

  assert.deepEqual(result, { status: "accepted", draftStashed: false });
  assert.deepEqual(
    runtime.sendCalls.map(({ args }) => args.slice(args.indexOf("--text") + 1)),
    [
      ["x", "--json"],
      ["\u007f", "--json"],
      ["hello", "--enter", "--wait-submit", "15", "--json"],
    ],
  );
});

function withComposerRow(screen: JsonObject, row: string): JsonObject {
  const tail = (screen.tail as string[]).map((line) => (/^❯\s/u.test(line) ? row : line));
  return { ...screen, tail };
}

test("Orca probes a named session's suggestion that it left on screen instead of in draft", async () => {
  const runtime = new FakeOrcaRuntime();
  const suggestion = capturedProbeScreen("named-session-suggestion.json");
  // Synthetic probe state derived from the raw named-session-suggestion.json capture.
  const withProbe = withComposerRow(suggestion, "❯\u00a0x");
  runtime.screen = suggestion;
  runtime.screenSequence = [suggestion, suggestion, withProbe, withProbe, withProbe, suggestion, suggestion, suggestion];
  runtime.sendReceipt = withSendStages(capturedSendResult, ["input_accepted"]);

  const result = await backend(runtime).submit(currentRef(), "hello", submitContext());

  assert.deepEqual(result, { status: "accepted", draftStashed: false });
  assert.deepEqual(
    runtime.sendCalls.map(({ args }) => args.slice(args.indexOf("--text") + 1)),
    [
      ["x", "--json"],
      ["\u007f", "--json"],
      ["hello", "--enter", "--wait-submit", "15", "--json"],
    ],
  );
});

test("Orca does not read a draft out of the rows below an unnamed rule", async () => {
  const runtime = new FakeOrcaRuntime();
  const named = capturedProbeScreen("named-session-suggestion.json");
  // Synthetic unnamed-rule state derived from the raw named-session-suggestion.json capture.
  const unnamed = {
    ...named,
    tail: (named.tail as string[]).map((line) => line.replace(/^(─+) design ─$/u, "$1──────────")),
  };
  runtime.screen = unnamed;

  await assert.rejects(
    backend(runtime).submit(currentRef(), "hello", submitContext()),
    (error: unknown) => error instanceof SubmitRefused && error.reason === "not-idle",
  );
  assert.deepEqual(runtime.sendCalls, []);
});

test("Orca accepts an empty composer after removing a suggestion", async () => {
  const runtime = new FakeOrcaRuntime();
  const suggestion = capturedProbeScreen("p4-10-suggestion.json");
  const withProbe = capturedProbeScreen("p4-11-suggestion-plus-x.json");
  // Synthetic empty-draft state derived from the raw p4-12-suggestion-after-bs.json capture.
  const empty = { ...capturedProbeScreen("p4-12-suggestion-after-bs.json"), draft: null };
  runtime.screen = empty;
  runtime.screenSequence = [
    suggestion,
    suggestion,
    withProbe,
    withProbe,
    withProbe,
    empty,
    empty,
    empty,
  ];
  runtime.sendReceipt = withSendStages(capturedSendResult, ["input_accepted"]);

  const result = await backend(runtime).submit(currentRef(), "hello", submitContext());

  assert.deepEqual(result, { status: "accepted", draftStashed: false });
  assert.equal(runtime.sendCalls.length, 3);
});

test("Orca requires two consecutive complete positive probe reads", async () => {
  const runtime = new FakeOrcaRuntime();
  const suggestion = capturedProbeScreen("p4-10-suggestion.json");
  const withProbe = capturedProbeScreen("p4-11-suggestion-plus-x.json");
  // Synthetic unexpected draft value derived from the raw p4-11-suggestion-plus-x.json capture.
  const fluctuating = { ...withProbe, draft: "unexpected" };
  // Synthetic incomplete-screen state derived from the raw p4-11-suggestion-plus-x.json capture.
  const incomplete = { ...withProbe, truncated: true };
  const restored = capturedProbeScreen("p4-12-suggestion-after-bs.json");
  runtime.screen = restored;
  runtime.screenSequence = [
    suggestion,
    suggestion,
    withProbe,
    fluctuating,
    incomplete,
    withProbe,
    withProbe,
    withProbe,
    restored,
    restored,
  ];
  runtime.sendReceipt = withSendStages(capturedSendResult, ["input_accepted"]);

  const result = await backend(runtime).submit(currentRef(), "hello", submitContext());

  assert.deepEqual(result, { status: "accepted", draftStashed: false });
  assert.equal(runtime.screenSequence.length, 0, "unstable and incomplete reads do not count as confirmations");
  assert.equal(runtime.sendCalls.length, 3);
});

test("Orca stashes a typed draft and submits only after Ctrl+S is verified", async () => {
  const runtime = new FakeOrcaRuntime();
  const draft = capturedProbeScreen("p4-00-draft.json");
  const withProbe = capturedProbeScreen("p4-01-draft-plus-x.json");
  const restored = capturedProbeScreen("p4-02-draft-after-bs.json");
  const stashed = capturedProbeScreen("p3-10-stashed.json");
  runtime.screen = stashed;
  runtime.screenSequence = [
    draft,
    draft,
    withProbe,
    withProbe,
    withProbe,
    restored,
    restored,
    restored,
    stashed,
    stashed,
  ];
  runtime.sendReceipt = withSendStages(capturedSendResult, ["input_accepted"]);

  const order: string[] = [];
  const execFile = runtime.execFile.bind(runtime);
  runtime.execFile = async (file, args, options) => {
    if (file === runtime.bin && args[0] === "terminal" && args[1] === "read") order.push("read");
    if (file === runtime.bin && args[0] === "terminal" && args[1] === "send") order.push("send");
    return execFile(file, args, options);
  };
  const terminals = backend(runtime);
  const sameProcess = terminals.sameProcess.bind(terminals);
  terminals.sameProcess = async (ref) => {
    const current = await sameProcess(ref);
    order.push("process");
    return current;
  };

  const result = await terminals.submit(currentRef(), "hello", submitContext());

  assert.deepEqual(result, { status: "accepted", draftStashed: true });
  assert.deepEqual(
    runtime.sendCalls.map(({ args }) => args.slice(args.indexOf("--text") + 1)),
    [
      ["x", "--json"],
      ["\u007f", "--json"],
      ["\u0013", "--json"],
      ["hello", "--enter", "--wait-submit", "15", "--json"],
    ],
  );
  assert.equal(order.filter((event) => event === "send").length, 4);
  for (let index = 0; index < order.length; index++) {
    if (order[index] === "send") {
      assert.deepEqual(order.slice(index - 2, index), ["read", "process"]);
    }
  }
});

test("Orca re-probes a stashed suggestion and refuses a second typed draft", async () => {
  const draft = capturedProbeScreen("p4-00-draft.json");
  const withProbe = capturedProbeScreen("p4-01-draft-plus-x.json");
  const restored = capturedProbeScreen("p4-02-draft-after-bs.json");
  // Synthetic draft override derived from the raw p4-10-suggestion.json capture.
  const stashedX = { ...capturedProbeScreen("p4-10-suggestion.json"), draft: "x" };
  // Synthetic draft override derived from the raw p4-11-suggestion-plus-x.json capture.
  const withY = { ...capturedProbeScreen("p4-11-suggestion-plus-x.json"), draft: "y" };
  // Synthetic draft override derived from the raw p4-12-suggestion-after-bs.json capture.
  const restoredX = { ...capturedProbeScreen("p4-12-suggestion-after-bs.json"), draft: "x" };
  // Synthetic draft override derived from the raw p4-11-suggestion-plus-x.json capture.
  const withXY = { ...capturedProbeScreen("p4-11-suggestion-plus-x.json"), draft: "xy" };

  const accepted = new FakeOrcaRuntime();
  accepted.screen = restoredX;
  accepted.screenSequence = [
    draft,
    draft,
    withProbe,
    withProbe,
    withProbe,
    restored,
    restored,
    restored,
    stashedX,
    stashedX,
    stashedX,
    withY,
    withY,
    withY,
    restoredX,
    restoredX,
  ];
  accepted.sendReceipt = withSendStages(capturedSendResult, ["input_accepted"]);
  assert.deepEqual(
    await backend(accepted).submit(currentRef(), "hello", submitContext()),
    { status: "accepted", draftStashed: true },
  );
  assert.deepEqual(
    accepted.sendCalls.map(({ args }) => args.slice(args.indexOf("--text") + 1)),
    [
      ["x", "--json"],
      ["\u007f", "--json"],
      ["\u0013", "--json"],
      ["y", "--json"],
      ["\u007f", "--json"],
      ["hello", "--enter", "--wait-submit", "15", "--json"],
    ],
  );

  const refused = new FakeOrcaRuntime();
  refused.screen = restoredX;
  refused.screenSequence = [
    draft,
    draft,
    withProbe,
    withProbe,
    withProbe,
    restored,
    restored,
    restored,
    stashedX,
    stashedX,
    stashedX,
    withXY,
    withXY,
    withXY,
    restoredX,
    restoredX,
  ];
  await assert.rejects(
    backend(refused).submit(currentRef(), "hello", submitContext()),
    (error: unknown) =>
      error instanceof SubmitRefused &&
      error.reason === "stash-unverified" &&
      error.composer.stash === "stashed" &&
      error.composer.submitUncertain === false,
  );
  assert.deepEqual(
    refused.sendCalls.map(({ args }) => args.slice(args.indexOf("--text") + 1)),
    [
      ["x", "--json"],
      ["\u007f", "--json"],
      ["\u0013", "--json"],
      ["y", "--json"],
      ["\u007f", "--json"],
    ],
  );
});

test("Orca probes exact x with y and rejects an unchanged stale draft", async () => {
  const runtime = new FakeOrcaRuntime();
  // Synthetic draft override derived from the raw p4-10-suggestion.json capture.
  const exactX = { ...capturedProbeScreen("p4-10-suggestion.json"), draft: "x" };
  runtime.screen = exactX;
  runtime.screenSequence = [exactX, exactX];

  await assert.rejects(
    backend(runtime).submit(currentRef(), "hello", submitContext()),
    (error: unknown) =>
      error instanceof SubmitRefused &&
      error.reason === "probe-unverified" &&
      error.composer.probe === "y" &&
      error.composer.stash === "untouched",
  );
  assert.deepEqual(
    runtime.sendCalls.map(({ args }) => args.slice(args.indexOf("--text") + 1)),
    [["y", "--json"]],
  );
});

test("Orca refuses when Backspace or Ctrl+S cannot be verified", async () => {
  const suggestion = capturedProbeScreen("p4-10-suggestion.json");
  const suggestionPlus = capturedProbeScreen("p4-11-suggestion-plus-x.json");
  const draft = capturedProbeScreen("p4-00-draft.json");
  const withProbe = capturedProbeScreen("p4-01-draft-plus-x.json");
  const restored = capturedProbeScreen("p4-02-draft-after-bs.json");
  const cases = [
    {
      reason: "probe-unverified" as const,
      sequence: [suggestion, suggestion, suggestionPlus, suggestionPlus, suggestionPlus],
      fallback: suggestionPlus,
      expected: [["x", "--json"], ["\u007f", "--json"]],
      probe: "x",
      stash: "untouched",
    },
    {
      reason: "stash-unverified" as const,
      sequence: [draft, draft, withProbe, withProbe, withProbe, restored, restored, restored],
      fallback: restored,
      expected: [["x", "--json"], ["\u007f", "--json"], ["\u0013", "--json"]],
      probe: null,
      stash: "uncertain",
    },
  ];

  for (const scenario of cases) {
    const runtime = new FakeOrcaRuntime();
    runtime.screen = scenario.fallback;
    runtime.screenSequence = scenario.sequence;
    await assert.rejects(
      backend(runtime).submit(currentRef(), "hello", submitContext()),
      (error: unknown) =>
        error instanceof SubmitRefused &&
        error.reason === scenario.reason &&
        error.composer.probe === scenario.probe &&
        error.composer.stash === scenario.stash,
      scenario.reason,
    );
    assert.deepEqual(
      runtime.sendCalls.map(({ args }) => args.slice(args.indexOf("--text") + 1)),
      scenario.expected,
    );
  }
});

test("Orca marks uncertain probe writes without retrying", async () => {
  const runtime = new FakeOrcaRuntime();
  const suggestion = capturedProbeScreen("p4-10-suggestion.json");
  runtime.screen = suggestion;
  runtime.screenSequence = [suggestion, suggestion];
  runtime.sendFailure = failure("runtime_unavailable", "transport failed");

  await assert.rejects(
    backend(runtime).submit(currentRef(), "hello", submitContext()),
    (error: unknown) =>
      error instanceof WriteOutcomeUnknown &&
      error.composer.probe === "x" &&
      error.composer.stash === "untouched" &&
      error.composer.submitUncertain === false,
  );
  assert.equal(runtime.sendCalls.length, 1);
  assert.deepEqual(runtime.sendCalls[0]!.args.slice(runtime.sendCalls[0]!.args.indexOf("--text") + 1), [
    "x",
    "--json",
  ]);
});

test("Orca marks an uncertain Ctrl+S write before stashing is confirmed", async () => {
  const runtime = new FakeOrcaRuntime();
  const draft = capturedProbeScreen("p4-00-draft.json");
  const withProbe = capturedProbeScreen("p4-01-draft-plus-x.json");
  const restored = capturedProbeScreen("p4-02-draft-after-bs.json");
  runtime.screen = restored;
  runtime.screenSequence = [
    draft,
    draft,
    withProbe,
    withProbe,
    withProbe,
    restored,
    restored,
    restored,
  ];
  runtime.afterSend = () => {
    if (runtime.sendCalls.length === 2) {
      runtime.sendFailure = failure("runtime_unavailable", "Ctrl+S transport failed");
    }
  };

  await assert.rejects(
    backend(runtime).submit(currentRef(), "hello", submitContext()),
    (error: unknown) =>
      error instanceof WriteOutcomeUnknown &&
      error.composer.probe === null &&
      error.composer.stash === "uncertain" &&
      error.composer.submitUncertain === false,
  );
  assert.deepEqual(
    runtime.sendCalls.map(({ args }) => args.slice(args.indexOf("--text") + 1)),
    [["x", "--json"], ["\u007f", "--json"], ["\u0013", "--json"]],
  );
});

test("Orca carries verified stash state through final gates and unknown submit outcomes", async () => {
  for (const finalError of ["agent_prompt_blocked", "runtime_unavailable"] as const) {
    const runtime = new FakeOrcaRuntime();
    const draft = capturedProbeScreen("p4-00-draft.json");
    const withProbe = capturedProbeScreen("p4-01-draft-plus-x.json");
    const restored = capturedProbeScreen("p4-02-draft-after-bs.json");
    const stashed = capturedProbeScreen("p3-10-stashed.json");
    runtime.screen = stashed;
    runtime.screenSequence = [
      draft,
      draft,
      withProbe,
      withProbe,
      withProbe,
      restored,
      restored,
      restored,
      stashed,
      stashed,
    ];
    runtime.afterSend = () => {
      if (runtime.sendCalls.length === 3) {
        runtime.sendFailure = failure(finalError, "final send is blocked or uncertain");
      }
    };
    let caught: unknown;
    await assert.rejects(
      backend(runtime).submit(currentRef(), "hello", submitContext()),
      (error: unknown) => {
        caught = error;
        return finalError === "agent_prompt_blocked"
          ? error instanceof SubmitRefused && error.reason === "gate"
          : error instanceof WriteOutcomeUnknown;
      },
    );
    assert.equal(runtime.sendCalls.length, 4);
    if (finalError === "agent_prompt_blocked") {
      assert.ok(caught instanceof SubmitRefused);
      assert.equal(caught.composer.stash, "stashed");
      assert.equal(caught.composer.submitUncertain, false);
    } else {
      assert.ok(caught instanceof WriteOutcomeUnknown);
      assert.equal(caught.composer.stash, "stashed");
      assert.equal(caught.composer.submitUncertain, true);
    }
  }
});
test("Orca classifies unconfirmed sends as outcome-unknown without retrying", async () => {
  const acceptedThenTransport = new FakeOrcaRuntime();
  acceptedThenTransport.screen = capturedClaudeScreen("idle-composer.screen.json");
  acceptedThenTransport.sendFailure = {
    stdout: "",
    stderr: "transport failed",
    exitCode: 1,
    error: "transport failed",
  };
  acceptedThenTransport.sendFailureAfterAccept = true;
  await assert.rejects(
    backend(acceptedThenTransport).submit(currentRef(), "hello", submitContext()),
    WriteOutcomeUnknown,
  );
  assert.equal(acceptedThenTransport.sendCalls.length, 1);
  assert.equal(acceptedThenTransport.acceptedInputWrites, 1);

  const malformedReceipt = new FakeOrcaRuntime();
  malformedReceipt.screen = capturedClaudeScreen("idle-composer.screen.json");
  malformedReceipt.sendFailure = { stdout: "not json", stderr: "", exitCode: 0 };
  malformedReceipt.sendFailureAfterAccept = true;
  await assert.rejects(
    backend(malformedReceipt).submit(currentRef(), "hello", submitContext()),
    WriteOutcomeUnknown,
  );
  assert.equal(malformedReceipt.sendCalls.length, 1);
  assert.equal(malformedReceipt.acceptedInputWrites, 1);

  const unconfirmedReceipt = new FakeOrcaRuntime();
  unconfirmedReceipt.screen = capturedClaudeScreen("idle-composer.screen.json");
  unconfirmedReceipt.sendReceipt = withSendStages(capturedSendResult, [], false);
  await assert.rejects(
    backend(unconfirmedReceipt).submit(currentRef(), "hello", submitContext()),
    WriteOutcomeUnknown,
  );
  assert.equal(unconfirmedReceipt.sendCalls.length, 1);
  assert.equal(unconfirmedReceipt.acceptedInputWrites, 0);

  const answerRuntime = new FakeOrcaRuntime();
  answerRuntime.screen = capturedClaudeScreen("ask-user-question-multiselect-before-down.screen.json");
  answerRuntime.sendFailure = failure("runtime_unavailable", "transport failed");
  answerRuntime.sendFailureAfterAccept = true;
  const prompt = capturedQuestion(answerRuntime.screen);
  const channel = backend(answerRuntime).openAnswer(currentRef(), prompt.verified);
  await assert.rejects(channel.digit(1, false), WriteOutcomeUnknown);
  assert.equal(answerRuntime.sendCalls.length, 1);
  assert.equal(answerRuntime.acceptedInputWrites, 1);
  await assert.rejects(channel.digit(1, false), ExpectationLost);
  assert.equal(answerRuntime.sendCalls.length, 1, "the closed channel cannot retry an uncertain write");
});

test("Orca submit checks cancellation before process inspection and at the write boundary", async () => {
  const alreadyCancelled = new FakeOrcaRuntime();
  await assert.rejects(
    backend(alreadyCancelled).submit(currentRef(), "hello", submitContext(() => true)),
    (error: unknown) => error instanceof SubmitRefused && error.reason === "cancelled",
  );
  assert.equal(alreadyCancelled.calls.length, 0);

  const cancelledAtWrite = new FakeOrcaRuntime();
  cancelledAtWrite.screen = capturedClaudeScreen("idle-composer.screen.json");
  const context = submitContext(
    () => cancelledAtWrite.calls.some((call) => call.file === "ps" && call.args[0] === "-axww"),
  );
  await assert.rejects(
    backend(cancelledAtWrite).submit(currentRef(), "hello", context),
    (error: unknown) => error instanceof SubmitRefused && error.reason === "cancelled",
  );
  assert.equal(cancelledAtWrite.sendCalls.length, 0);
  assert.equal(cancelledAtWrite.acceptedInputWrites, 0);
});
test("Orca writes read their terminal and screen before the final process check", async () => {
  const paths = ["submit", "answer", "blind", "composer"] as const;
  const idle = capturedClaudeScreen("idle-composer.screen.json");
  const question = capturedClaudeScreen("ask-user-question-multiselect-before-down.screen.json");

  const write = async (runtime: FakeOrcaRuntime, path: (typeof paths)[number]): Promise<void> => {
    runtime.screen = path === "answer" ? question : idle;
    const terminals = backend(runtime);
    if (path === "submit") {
      await terminals.submit(currentRef(), "hello", submitContext());
    } else if (path === "answer") {
      const prompt = capturedQuestion(runtime.screen);
      await terminals.openAnswer(currentRef(), prompt.verified).digit(1, false);
    } else if (path === "blind") {
      const prompt = claudeDriver.parseBlockedPane("ordinary terminal output");
      if (prompt.kind !== "blind-permission") throw new Error("expected a blind prompt");
      await terminals.openBlind(currentRef(), prompt.blind).answer("y");
    } else {
      await terminals.openComposer(currentRef(), claudeDriver).backTab();
    }
  };

  for (const path of paths) {
    const runtime = new FakeOrcaRuntime();
    await write(runtime, path);
    assertLastWriteOrder(runtime, path);
  }

  for (const switchAt of ["terminal list", "terminal read"] as const) {
    for (const path of paths) {
      const runtime = new FakeOrcaRuntime();
      const original = runtime.processes[0]!;
      const switchProcess = () => {
        runtime.processes = [{ ...original, lstart: "Mon Sep 28 21:00:00 2026" }];
      };
      if (switchAt === "terminal list") runtime.terminalListHook = switchProcess;
      else runtime.screenReadHook = switchProcess;

      await assert.rejects(
        write(runtime, path),
        (error: unknown) =>
          path === "submit"
            ? error instanceof SubmitRefused && error.reason === "agent-changed"
            : error instanceof ExpectationLost,
        `${path} after switch during ${switchAt}`,
      );
      assert.equal(runtime.sendCalls.length, 0, `${path} after switch during ${switchAt}`);
    }
  }
});
test("Orca refuses unsendable C0 input before commands and accepts multiline text", async () => {
  const unsafe = "\u001b[A\r";
  const multiline = "first line\nsecond\tfield";
  const idle = capturedClaudeScreen("idle-composer.screen.json");
  const question = capturedClaudeScreen("ask-user-question-multiselect-before-down.screen.json");

  const unsafeSubmit = new FakeOrcaRuntime();
  unsafeSubmit.screen = idle;
  await assert.rejects(
    backend(unsafeSubmit).submit(currentRef(), unsafe, submitContext()),
    (error: unknown) =>
      error instanceof SubmitRefused &&
      error.reason === "unsafe-text" &&
      error.message.includes("制御文字"),
  );
  assert.equal(unsafeSubmit.calls.length, 0);

  const carriageReturnSubmit = new FakeOrcaRuntime();
  await assert.rejects(
    backend(carriageReturnSubmit).submit(currentRef(), "\r", submitContext()),
    (error: unknown) => error instanceof SubmitRefused && error.reason === "unsafe-text",
  );
  assert.equal(carriageReturnSubmit.calls.length, 0);

  const unsafeAnswer = new FakeOrcaRuntime();
  unsafeAnswer.screen = question;
  const unsafePrompt = capturedQuestion(unsafeAnswer.screen);
  await assert.rejects(
    backend(unsafeAnswer)
      .openAnswer(currentRef(), unsafePrompt.verified)
      .text(unsafe),
    (error: unknown) => error instanceof ExpectationLost && error.userMessage?.includes("制御文字"),
  );
  assert.equal(unsafeAnswer.calls.length, 0);

  const unsafeDriverAnswer = new FakeOrcaRuntime();
  unsafeDriverAnswer.screen = question;
  const driverPrompt = capturedQuestion(unsafeDriverAnswer.screen);
  const terminals = backend(unsafeDriverAnswer);
  await assert.rejects(
    claudeDriver.answerQuestionFreeText!(
      terminals,
      terminals.openAnswer(currentRef(), driverPrompt.verified),
      currentRef(),
      driverPrompt.info,
      unsafe,
    ),
    (error: unknown) => error instanceof ExpectationLost && error.userMessage?.includes("制御文字"),
  );
  assert.equal(unsafeDriverAnswer.calls.length, 0, "unsafe text is rejected before arrow navigation");

  const safeSubmit = new FakeOrcaRuntime();
  safeSubmit.screen = idle;
  await backend(safeSubmit).submit(currentRef(), multiline, submitContext());
  const submittedText = safeSubmit.sendCalls[0]!.args;
  assert.equal(submittedText[submittedText.indexOf("--text") + 1], multiline);
  assertLastWriteOrder(safeSubmit, "multiline submit");

  const safeAnswer = new FakeOrcaRuntime();
  safeAnswer.screen = question;
  const safePrompt = capturedQuestion(safeAnswer.screen);
  await backend(safeAnswer).openAnswer(currentRef(), safePrompt.verified).text(multiline);
  const answeredText = safeAnswer.sendCalls[0]!.args;
  assert.equal(answeredText[answeredText.indexOf("--text") + 1], multiline);
  assertLastWriteOrder(safeAnswer, "multiline answer");
});

test("Orca answer confirmation accepts the captured unnumbered Submit row and writes Enter alone", async () => {
  const runtime = new FakeOrcaRuntime();
  runtime.screen = capturedClaudeScreen("ask-user-question-multiselect-submit-row.screen.json");
  const prompt = capturedQuestion(capturedClaudeScreen("ask-user-question-multiselect-before-down.screen.json"));
  const channel = backend(runtime).openAnswer(currentRef(), prompt.verified);

  await channel.confirm("Submit", false);

  assert.equal(runtime.sendCalls.length, 1);
  assert.equal(runtime.sendCalls[0]!.args.includes("--enter"), true);
  assert.equal(runtime.sendCalls[0]!.args.includes("--text"), false);
  assert.equal(runtime.sendCalls[0]!.args.some((arg) => arg.includes("\u001b") || arg.includes("\r")), false);
});

test("Orca answer channel batches repeated arrows and never combines them with Enter", async () => {
  const runtime = new FakeOrcaRuntime();
  runtime.screen = capturedClaudeScreen("ask-user-question-multiselect-before-down.screen.json");
  runtime.afterSend = () => {
    if (runtime.sendCalls.length === 1) {
      runtime.screen = capturedClaudeScreen("ask-user-question-multiselect-submit-row.screen.json");
    }
  };
  const prompt = capturedQuestion(runtime.screen);
  const channel = backend(runtime).openAnswer(currentRef(), prompt.verified);

  await channel.move("Down", 4);
  await channel.confirm("Submit", false);

  assert.equal(runtime.sendCalls.length, 2);
  const arrowArgs = runtime.sendCalls[0]!.args;
  assert.equal(arrowArgs[arrowArgs.indexOf("--text") + 1], "\u001b[B".repeat(4));
  assert.equal(arrowArgs.includes("--enter"), false);
  const enterArgs = runtime.sendCalls[1]!.args;
  assert.equal(enterArgs.includes("--text"), false);
  assert.deepEqual(enterArgs.slice(enterArgs.indexOf("--enter")), ["--enter", "--json"]);
  for (const { args } of runtime.sendCalls) {
    const textIndex = args.indexOf("--text");
    const payload = textIndex < 0 ? "" : args[textIndex + 1]!;
    assert.equal(args.includes("--enter") && payload.includes("\u001b"), false);
    assert.equal(payload.includes("\u001b") && payload.includes("\r"), false);
  }
});

test("Orca answer channel skips a second write after the prompt fingerprint changes", async () => {
  const runtime = new FakeOrcaRuntime();
  runtime.screen = capturedClaudeScreen("ask-user-question-multiselect-before-down.screen.json");
  const prompt = capturedQuestion(runtime.screen);
  runtime.afterSend = () => {
    runtime.screen = capturedClaudeScreen("ask-user-question-multiselect-review.screen.json");
  };
  const channel = backend(runtime).openAnswer(currentRef(), prompt.verified);

  await channel.digit(1, false);
  await assert.rejects(channel.digit(3, false), ExpectationLost);

  assert.equal(runtime.sendCalls.length, 1);
  assert.equal(runtime.acceptedInputWrites, 1);
});

test("Orca Claude multi-select sends 1 only after the captured review is verified", async () => {
  const runtime = new FakeOrcaRuntime();
  runtime.screen = capturedClaudeScreen("ask-user-question-multiselect-before-down.screen.json");
  runtime.afterSend = () => {
    if (runtime.sendCalls.length === 3) {
      runtime.screen = capturedClaudeScreen("ask-user-question-multiselect-submit-row.screen.json");
    }
    if (runtime.sendCalls.length === 4) {
      runtime.screen = capturedClaudeScreen("ask-user-question-multiselect-review.screen.json");
    }
  };
  const prompt = capturedQuestion(runtime.screen);
  const terminals = backend(runtime);

  await claudeDriver.answerQuestionMultiSelect!(
    terminals,
    terminals.openAnswer(currentRef(), prompt.verified),
    currentRef(),
    [1, 3],
    prompt.info,
  );

  assert.equal(runtime.sendCalls.length, 5);
  const finalWrite = runtime.sendCalls[4]!.args;
  assert.equal(finalWrite[finalWrite.indexOf("--text") + 1], "1");
  assert.equal(finalWrite.includes("--enter"), false);
  assertLastWriteOrder(runtime, "Q2 review confirmation");
});

test("Orca Claude multi-select refuses incomplete or mismatched reviews without sending 1", async () => {
  const reviewFailure = "確認画面を確かめられなかったので送信していません。端末で確かめてください";
  // These synthetic rejection screens all derive from the raw review capture named below.
  const invalidReviews: Array<{ name: string; make(): JsonObject }> = [
    {
      name: "missing Cancel",
      make: () => {
        const screen = capturedClaudeScreen("ask-user-question-multiselect-review.screen.json");
        const tail = [...(screen.tail as string[])];
        tail.pop();
        return { ...screen, tail };
      },
    },
    {
      name: "wrong heading",
      make: () => {
        const screen = capturedClaudeScreen("ask-user-question-multiselect-review.screen.json");
        const tail = [...(screen.tail as string[])];
        tail[tail.indexOf("Ready to submit your answers?")] = "Ready to submit?";
        return { ...screen, tail };
      },
    },
    {
      name: "answer mismatch",
      make: () => {
        const screen = capturedClaudeScreen("ask-user-question-multiselect-review.screen.json");
        const tail = [...(screen.tail as string[])];
        tail[tail.indexOf("   → Amber, Jade")] = "   → Amber, Cobalt";
        return { ...screen, tail };
      },
    },
    {
      name: "missing answer list",
      make: () => {
        const screen = capturedClaudeScreen("ask-user-question-multiselect-review.screen.json");
        const tail = (screen.tail as string[]).filter((row) => !row.trimStart().startsWith("→"));
        return { ...screen, tail };
      },
    },
    {
      name: "incomplete screen",
      make: () => ({
        ...capturedClaudeScreen("ask-user-question-multiselect-review.screen.json"),
        limited: true,
      }),
    },
    {
      name: "cursor on Cancel",
      make: () => {
        const screen = capturedClaudeScreen("ask-user-question-multiselect-review.screen.json");
        const tail = [...(screen.tail as string[])];
        const submitAt = tail.indexOf("❯ 1. Submit answers");
        tail[submitAt] = "  1. Submit answers";
        tail[submitAt + 1] = "❯ 2. Cancel";
        return { ...screen, tail };
      },
    },
    {
      name: "later question below Cancel",
      make: () => {
        const screen = capturedClaudeScreen("ask-user-question-multiselect-review.screen.json");
        const tail = [...(screen.tail as string[])];
        tail.push(
          " ☐ Later question",
          "Later question: choose the replacement answer?",
          "❯ 1. Keep",
          "  2. Change",
          "  3. Type something.",
        );
        return { ...screen, tail };
      },
    },
  ];

  for (const invalidReview of invalidReviews) {
    const runtime = new FakeOrcaRuntime();
    runtime.screen = capturedClaudeScreen("ask-user-question-multiselect-before-down.screen.json");
    runtime.afterSend = () => {
      if (runtime.sendCalls.length === 3) {
        runtime.screen = capturedClaudeScreen("ask-user-question-multiselect-submit-row.screen.json");
      }
      if (runtime.sendCalls.length === 4) runtime.screen = invalidReview.make();
    };
    const prompt = capturedQuestion(runtime.screen);
    const terminals = backend(runtime);
    await assert.rejects(
      claudeDriver.answerQuestionMultiSelect!(
        terminals,
        terminals.openAnswer(currentRef(), prompt.verified),
        currentRef(),
        [1, 3],
        prompt.info,
      ),
      (error: unknown) =>
        error instanceof ExpectationLost &&
        error.message === reviewFailure &&
        error.userMessage === reviewFailure,
      invalidReview.name,
    );
    assert.equal(runtime.sendCalls.length, 4, invalidReview.name);
    assert.equal(runtime.sendCalls[3]!.args.includes("--enter"), true, invalidReview.name);
    assert.equal(runtime.acceptedInputWrites, 4, invalidReview.name);
  }
});
test("Orca rechecks the Submit cursor on the fresh write snapshot", async () => {
  const runtime = new FakeOrcaRuntime();
  runtime.screen = capturedClaudeScreen("ask-user-question-multiselect-before-down.screen.json");
  runtime.afterSend = () => {
    if (runtime.sendCalls.length === 3) {
      runtime.screen = capturedClaudeScreen("ask-user-question-multiselect-submit-row.screen.json");
    }
    if (runtime.sendCalls.length === 4) {
      runtime.screen = capturedClaudeScreen("ask-user-question-multiselect-review.screen.json");
    }
  };
  let reviewRead = false;
  runtime.screenReadHook = () => {
    if (reviewRead || !capturedText(runtime.screen).includes("Ready to submit your answers?")) return;
    reviewRead = true;
    // Synthetic cursor move derived from ask-user-question-multiselect-review.screen.json.
    const screen = capturedClaudeScreen("ask-user-question-multiselect-review.screen.json");
    const tail = [...(screen.tail as string[])];
    const submitAt = tail.indexOf("❯ 1. Submit answers");
    tail[submitAt] = "  1. Submit answers";
    tail[submitAt + 1] = "❯ 2. Cancel";
    runtime.screen = { ...screen, tail };
  };
  const prompt = capturedQuestion(runtime.screen);
  const terminals = backend(runtime);
  await assert.rejects(
    claudeDriver.answerQuestionMultiSelect!(
      terminals,
      terminals.openAnswer(currentRef(), prompt.verified),
      currentRef(),
      [1, 3],
      prompt.info,
    ),
    ExpectationLost,
  );
  assert.equal(runtime.sendCalls.length, 4, "the later Cancel cursor receives no 1");
});

test("Orca Q2 timeout refuses a matching review returned after two seconds", async () => {
  const reviewFailure = "確認画面を確かめられなかったので送信していません。端末で確かめてください";
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  try {
    const runtime = new FakeOrcaRuntime();
    runtime.screen = capturedClaudeScreen("ask-user-question-multiselect-before-down.screen.json");
    runtime.afterSend = () => {
      if (runtime.sendCalls.length === 3) {
        runtime.screen = capturedClaudeScreen("ask-user-question-multiselect-submit-row.screen.json");
      }
      if (runtime.sendCalls.length === 4) {
        runtime.screen = capturedClaudeScreen("ask-user-question-multiselect-review.screen.json");
      }
    };
    let delayedRead = false;
    runtime.screenReadHook = () => {
      if (!delayedRead && capturedText(runtime.screen).includes("Ready to submit your answers?")) {
        delayedRead = true;
        now += 2_001;
      }
    };
    const prompt = capturedQuestion(runtime.screen);
    const terminals = backend(runtime);
    await assert.rejects(
      claudeDriver.answerQuestionMultiSelect!(
        terminals,
        terminals.openAnswer(currentRef(), prompt.verified),
        currentRef(),
        [1, 3],
        prompt.info,
      ),
      (error: unknown) =>
        error instanceof ExpectationLost &&
        error.message === reviewFailure &&
        error.userMessage === reviewFailure,
    );
    assert.equal(delayedRead, true);
    assert.equal(runtime.sendCalls.length, 4, "a matching review returned after the deadline receives no 1");
  } finally {
    Date.now = originalNow;
  }
});

test("Orca Claude multi-select never confirms when the review screen does not appear", async () => {
  const runtime = new FakeOrcaRuntime();
  runtime.screen = capturedClaudeScreen("ask-user-question-multiselect-before-down.screen.json");
  runtime.afterSend = () => {
    if (runtime.sendCalls.length === 3) {
      runtime.screen = capturedClaudeScreen("ask-user-question-multiselect-submit-row.screen.json");
    }
    if (runtime.sendCalls.length === 4) {
      runtime.screen = capturedClaudeScreen("idle-composer.screen.json");
    }
  };
  const prompt = capturedQuestion(runtime.screen);
  const terminals = backend(runtime);
  await assert.rejects(
    claudeDriver.answerQuestionMultiSelect!(
      terminals,
      terminals.openAnswer(currentRef(), prompt.verified),
      currentRef(),
      [1, 3],
      prompt.info,
    ),
    ExpectationLost,
  );
  assert.equal(runtime.sendCalls.length, 4);
  assert.equal(runtime.sendCalls[3]!.args.includes("--enter"), true);
});

function blindPrompt() {
  const parsed = claudeDriver.parseBlockedPane("ordinary terminal output");
  if (parsed.kind !== "blind-permission") throw new Error("expected a blind permission prompt");
  return parsed.blind;
}

test("Orca blind permission sends exactly one y-or-n byte without Enter while the agent waits", async () => {
  const runtime = new FakeOrcaRuntime();
  runtime.screen = capturedClaudeScreen("working.screen.json");
  const channel = backend(runtime).openBlind(currentRef(), blindPrompt());

  await channel.answer("y");
  await assert.rejects(channel.answer("n"), ExpectationLost);

  assert.equal(runtime.sendCalls.length, 1);
  assert.equal(runtime.sendCalls[0]!.args[runtime.sendCalls[0]!.args.indexOf("--text") + 1], "y");
  assert.equal(runtime.sendCalls[0]!.args.includes("--enter"), false);
});

test("Orca blind permission refuses once someone answered at the terminal", async () => {
  // Answered at the terminal while the Slack button was still up: the composer
  // is back, and a `y` sent now would land in it as the start of a message.
  const answered = new FakeOrcaRuntime();
  answered.screen = capturedClaudeScreen("idle-composer.screen.json");
  await assert.rejects(backend(answered).openBlind(currentRef(), blindPrompt()).answer("y"), ExpectationLost);
  assert.equal(answered.sendCalls.length, 0);

  const resumed = new FakeOrcaRuntime();
  resumed.screen = capturedClaudeScreen("working.screen.json");
  resumed.worktreeAgentsOverride = [{ ...worktreeQuestionAgent, state: "working" }];
  await assert.rejects(backend(resumed).openBlind(currentRef(), blindPrompt()).answer("y"), ExpectationLost);
  assert.equal(resumed.sendCalls.length, 0);
});

test("Orca composer BackTab is one raw write after process, screen, idle, and draft gates", async () => {
  const idle = () => capturedClaudeScreen("idle-composer.screen.json");
  const eligibleScreens = [
    { name: "ordinary idle composer", screen: idle() },
    { name: "fresh probe Try placeholder", screen: capturedProbeScreen("probe-A-fresh.json") },
  ];
  for (const { name, screen } of eligibleScreens) {
    const runtime = new FakeOrcaRuntime();
    runtime.screen = screen;
    const channel = backend(runtime).openComposer(currentRef(), claudeDriver);
    await channel.backTab();
    await assert.rejects(channel.backTab(), ExpectationLost);
    assert.equal(runtime.sendCalls.length, 1, name);
    assert.equal(runtime.sendCalls[0]!.args[runtime.sendCalls[0]!.args.indexOf("--text") + 1], "\u001b[Z", name);
    assert.equal(runtime.sendCalls[0]!.args.includes("--enter"), false, name);
  }

  const blocked: Array<{ name: string; prepare(runtime: FakeOrcaRuntime): AgentRef }> = [
    {
      name: "changed process",
      prepare: () => {
        const ref = currentRef();
        return { ...ref, processStartedAt: (ref.processStartedAt ?? 0) + 1 };
      },
    },
    {
      name: "incomplete screen",
      prepare: (runtime) => {
        // Synthetic limited-screen variant derived from idle-composer.screen.json.
        runtime.screen = { ...idle(), limited: true };
        return currentRef();
      },
    },
    {
      name: "non-idle composer",
      prepare: (runtime) => {
        runtime.screen = capturedClaudeScreen("ask-user-question-multiselect-before-down.screen.json");
        return currentRef();
      },
    },
    {
      name: "non-empty draft",
      prepare: (runtime) => {
        // Synthetic draft overlay derived from idle-composer.screen.json.
        runtime.screen = { ...idle(), draft: "unsent draft" };
        return currentRef();
      },
    },
  ];
  for (const gate of blocked) {
    const blockedRuntime = new FakeOrcaRuntime();
    blockedRuntime.screen = idle();
    const ref = gate.prepare(blockedRuntime);
    await assert.rejects(backend(blockedRuntime).openComposer(ref, claudeDriver).backTab(), ExpectationLost, gate.name);
    assert.equal(blockedRuntime.sendCalls.length, 0, gate.name);
  }
});

test("Orca does not expose Codex Escape model menus", () => {
  const runtime = new FakeOrcaRuntime();
  assert.throws(() => backend(runtime).openModelAnswer(currentRef(), {} as never), ExpectationLost);
  assert.equal(runtime.sendCalls.length, 0);
});
test("Orca Enter is refused when the captured cursor label does not match", async () => {
  const runtime = new FakeOrcaRuntime();
  runtime.screen = capturedClaudeScreen("ask-user-question-multiselect-before-down.screen.json");
  const prompt = capturedQuestion(runtime.screen);
  const channel = backend(runtime).openAnswer(currentRef(), prompt.verified);

  await assert.rejects(channel.confirm("Submit", false), ExpectationLost);
  assert.equal(runtime.sendCalls.length, 0);
});

test("Orca multi-select free text verifies its own answer in the review screen", async () => {
  const runtime = new FakeOrcaRuntime();
  runtime.screen = capturedClaudeScreen("ask-user-question-multiselect-before-down.screen.json");
  runtime.afterSend = () => {
    if (runtime.sendCalls.length === 3) {
      runtime.screen = capturedClaudeScreen("ask-user-question-multiselect-submit-row.screen.json");
    }
    if (runtime.sendCalls.length === 4) {
      // Synthetic answer alteration derived from ask-user-question-multiselect-review.screen.json.
      const review = capturedClaudeScreen("ask-user-question-multiselect-review.screen.json");
      const tail = [...(review.tail as string[])];
      tail[tail.indexOf("   → Amber, Jade")] = "   → Other color";
      runtime.screen = { ...review, tail };
    }
  };
  const prompt = capturedQuestion(runtime.screen);
  const terminals = backend(runtime);

  await claudeDriver.answerQuestionFreeText!(
    terminals,
    terminals.openAnswer(currentRef(), prompt.verified),
    currentRef(),
    prompt.info,
    "Other color",
  );

  assert.equal(runtime.sendCalls.length, 5);
  assert.equal(runtime.sendCalls[4]!.args[runtime.sendCalls[4]!.args.indexOf("--text") + 1], "1");
});
