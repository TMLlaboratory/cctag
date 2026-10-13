import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { homedir } from "node:os";
import { open, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { AgentDriver, OrcaProcessAccess, OrcaProcessIdentity, OrcaProcessSession } from "../agents/driver.js";
import { ORCA_AGENT_DRIVERS } from "../agents/driver.js";
import { CODEX_ORCA_TERMINAL_ANSWER } from "../agents/codex/driver.js";
import type {
  AnswerChannel,
  BlindChannel,
  ComposerChannel,
  ModelAnswerChannel,
  SubmitContext,
  SubmitOutcome,
  Terminals,
} from "./index.js";
import type { BlindPermissionPrompt, VerifiedModelMenuPrompt, VerifiedPrompt } from "./prompt.js";
import {
  BackendUnavailable,
  EMPTY_SUBMIT_COMPOSER_STATE,
  ExpectationLost,
  hasUnsendableC0Controls,
  type AgentInfo,
  type AgentRef,
  type ListResult,
  type ScreenSnapshot,
  type SubmitComposerState,
  type TranscriptIdentity,
  SubmitRefused,
  UnknownTarget,
  UNSENDABLE_TEXT_MESSAGE,
  WriteOutcomeUnknown,
} from "./types.js";
import { stripSidePane } from "./side-pane.js";
import { backendForTarget } from "./target.js";

const execFileAsync = promisify(execFile);
const ORCA_TIMEOUT_MS = 5_000;
const SUBMIT_TIMEOUT_MS = 25_000;
const PROBE_POLL_MS = 150;
const PROBE_TIMEOUT_MS = 3_000;
type StableComposerRead = { draft: string | null; snapshot: ScreenSnapshot };

function normalizedDraft(draft: string | null): string | null {
  return draft === "" ? null : draft;
}

const PS_ARGS = ["-axww", "-o", "pid=,ppid=,pgid=,tpgid=,tty=,lstart=,command="];
const STALE_HANDLE = "terminal_handle_stale";

type JsonObject = Record<string, unknown>;

export interface OrcaExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  error?: string;
}

export interface OrcaRuntime extends Omit<OrcaProcessAccess, "runSystem"> {
  execFile(file: string, args: string[], options: { timeoutMs: number }): Promise<OrcaExecResult>;
}

interface ProcessRow {
  pid: number;
  ppid: number;
  pgid: number;
  tpgid: number;
  tty: string;
  startedAt: number | null;
  command: string;
  driver?: AgentDriver;
  paneKey?: string;
  terminalHandle?: string;
  cwd?: string;
  piCodingAgentDirSet?: boolean;
}

type AgentProcessRow = ProcessRow & { driver: AgentDriver };


function isAgentProcess(row: ProcessRow): row is AgentProcessRow {
  return row.driver !== undefined;
}

interface TerminalList {
  terminals: JsonObject[];
  complete: boolean;
}

interface WorktreePs {
  agents: JsonObject[];
  truncated: boolean;
}

class OrcaCliError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}


function object(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : null;
}

function stringField(value: JsonObject, key: string): string | null {
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Not every lsof exit 1: a bad option exits 1 too, and differs only in
// explaining itself on stderr (measured on macOS).
function lsofFoundOnlySome(file: string, result: OrcaExecResult): boolean {
  return file === "lsof" && result.exitCode === 1 && !result.stderr.trim();
}

function resultError(result: OrcaExecResult): string {
  return result.stderr.trim() || result.error || `command exited with status ${result.exitCode}`;
}

function parseEnvelope(output: string): JsonObject {
  try {
    const parsed = object(JSON.parse(output));
    if (!parsed) throw new Error("response is not an object");
    return parsed;
  } catch (error) {
    throw new BackendUnavailable(`orca returned invalid JSON: ${errorMessage(error)}`);
  }
}

function lstartTimestamp(value: string): number | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function parsePsRow(line: string, drivers: readonly AgentDriver[]): ProcessRow | null {
  const match = line.match(
    /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s*(.*)$/,
  );
  if (!match) return null;
  const command = match[7] ?? "";
  const driver = drivers.find((candidate) => candidate.orcaProcess?.matchesCommand(command));
  return {
    pid: Number(match[1]),
    ppid: Number(match[2]),
    pgid: Number(match[3]),
    tpgid: Number(match[4]),
    tty: match[5] ?? "",
    startedAt: lstartTimestamp(match[6] ?? ""),
    command,
    ...(driver ? { driver } : {}),
  };
}

function parsePsRows(output: string, drivers: readonly AgentDriver[]): ProcessRow[] {
  return output.split("\n").map((line) => parsePsRow(line, drivers)).filter((row): row is ProcessRow => row !== null);
}

function parseEnvironmentRows(
  output: string,
): Map<number, { paneKey?: string; terminalHandle?: string; piCodingAgentDirSet: boolean }> {
  const environments = new Map<number, { paneKey?: string; terminalHandle?: string; piCodingAgentDirSet: boolean }>();
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[2] ?? "";
    const paneKey = command.match(/(?:^|\s)ORCA_PANE_KEY=([^\s]+)/)?.[1];
    const terminalHandle = command.match(/(?:^|\s)ORCA_TERMINAL_HANDLE=([^\s]+)/)?.[1];
    const piCodingAgentDirSet = /(?:^|\s)PI_CODING_AGENT_DIR(?:=[^\s]*)?(?=\s|$)/u.test(command);
    environments.set(pid, { paneKey, terminalHandle, piCodingAgentDirSet });
  }
  return environments;
}

function parseLsofCwds(output: string): Map<number, string> {
  const cwds = new Map<number, string>();
  let pid: number | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) {
      const parsed = Number(line.slice(1));
      pid = Number.isInteger(parsed) ? parsed : null;
    } else if (pid !== null && line.startsWith("n")) {
      const cwd = line.slice(1);
      if (cwd) cwds.set(pid, cwd);
    }
  }
  return cwds;
}

function hasTty(row: ProcessRow): boolean {
  return row.tty !== "" && row.tty !== "??" && row.tty !== "-";
}

function isForeground(row: ProcessRow): boolean {
  return hasTty(row) && row.pgid === row.tpgid;
}

function processMap(rows: readonly ProcessRow[]): Map<number, ProcessRow> {
  return new Map(rows.map((row) => [row.pid, row]));
}

function isDescendant(row: ProcessRow, ancestor: ProcessRow, byPid: Map<number, ProcessRow>): boolean {
  let parentPid = row.ppid;
  const visited = new Set<number>();
  while (parentPid > 0 && !visited.has(parentPid)) {
    if (parentPid === ancestor.pid) return true;
    visited.add(parentPid);
    const parent = byPid.get(parentPid);
    if (!parent) return false;
    parentPid = parent.ppid;
  }
  return false;
}

/** Shared by discovery and sameProcess; an agent child on the same foreground TTY makes ownership uncertain. */
function hasSameTtyForegroundChild(
  parent: ProcessRow,
  allRows: readonly ProcessRow[],
  byPid: Map<number, ProcessRow>,
): boolean {
  return allRows.some(
    (child) =>
      isAgentProcess(child) &&
      child.pid !== parent.pid &&
      child.tty === parent.tty &&
      isForeground(child) &&
      isDescendant(child, parent, byPid),
  );
}

function safeOuterProcess(candidates: readonly AgentProcessRow[], allRows: readonly ProcessRow[]): AgentProcessRow | null {
  const byPid = processMap(allRows);
  const outermost = candidates.filter(
    (candidate) => !candidates.some((other) => other.pid !== candidate.pid && isDescendant(candidate, other, byPid)),
  );
  if (outermost.length !== 1) return null;
  const outer = outermost[0]!;
  if (!isForeground(outer)) return null;
  return hasSameTtyForegroundChild(outer, allRows, byPid) ? null : outer;
}

function paneKeyOfTerminal(terminal: JsonObject): string | null {
  const tabId = stringField(terminal, "tabId");
  const leafId = stringField(terminal, "leafId");
  if (!tabId || !leafId || tabId.startsWith("pty:") || leafId.startsWith("pty:")) return null;
  return `${tabId}:${leafId}`;
}

function hasOrdinaryPaneKey(
  terminals: TerminalList,
  rows: readonly ProcessRow[] | undefined,
  paneKey: string,
  candidate: JsonObject,
): boolean {
  if (
    terminals.terminals.some(
      (terminal) => terminal !== candidate && paneKeyOfTerminal(terminal) === paneKey,
    )
  ) {
    return true;
  }
  return rows?.some((row) => row.paneKey === paneKey) ?? false;
}

function terminalForPane(
  terminals: TerminalList,
  paneKey: string,
  preferredHandle?: string,
  rows?: readonly ProcessRow[],
): { terminal: JsonObject | null; needsEnvironmentHandle: boolean } {
  // Pane identity is authoritative; environment handles are only a guarded
  // fallback for orphaned terminals whose key is not another pane's ordinary key.
  const direct = terminals.terminals.filter((terminal) => paneKeyOfTerminal(terminal) === paneKey);
  if (direct.length === 1) return { terminal: direct[0]!, needsEnvironmentHandle: false };
  if (direct.length > 1) return { terminal: null, needsEnvironmentHandle: false };
  if (!preferredHandle) return { terminal: null, needsEnvironmentHandle: true };
  const fallback = terminals.terminals.filter((terminal) => stringField(terminal, "handle") === preferredHandle);
  if (fallback.length !== 1) return { terminal: null, needsEnvironmentHandle: false };
  const terminal = fallback[0]!;
  const tabId = stringField(terminal, "tabId");
  const leafId = stringField(terminal, "leafId");
  if (terminal.orphaned !== true || !tabId || !leafId) {
    return { terminal: null, needsEnvironmentHandle: false };
  }
  const paneIdPair = `${tabId}:${leafId}`;
  if (hasOrdinaryPaneKey(terminals, rows, paneIdPair, terminal)) {
    return { terminal: null, needsEnvironmentHandle: false };
  }
  return { terminal, needsEnvironmentHandle: false };
}

function rowsForPane(rows: readonly ProcessRow[], paneKey: string): AgentProcessRow[] {
  return rows.filter((row): row is AgentProcessRow => row.driver !== undefined && row.paneKey === paneKey);
}

function targetPaneKey(target: string): string {
  if (backendForTarget(target) !== "orca" || target.length === "orca:".length) {
    throw new UnknownTarget(`No Orca target is available for ${target}`);
  }
  return target.slice("orca:".length);
}

function usableTerminal(terminal: JsonObject): boolean {
  return terminal.writable === true && !terminal.exitCause;
}

function worktreeAgentForPane(worktree: WorktreePs | null, paneKey: string): JsonObject | null {
  return worktree?.agents.find((agent) => stringField(agent, "paneKey") === paneKey) ?? null;
}

function timestampField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function statusEvidence(agent: JsonObject | null, terminal: JsonObject | null = null): AgentInfo["evidence"] {
  const rawState = agent?.state;
  const state = rawState === "working" || rawState === "waiting" || rawState === "done" ? rawState : null;
  const wait = object(terminal?.agentWait);
  const waitingSince =
    (state === "waiting" ? timestampField(agent?.stateStartedAt) : null) ?? timestampField(wait?.since);
  return { kind: "hint", state, waitingSince };
}

function agentInfo(
  paneKey: string,
  terminal: JsonObject,
  process: AgentProcessRow,
  session: OrcaProcessSession,
  evidence: AgentInfo["evidence"],
  pickerState: string | null,
): AgentInfo {
  const target = `orca:${paneKey}`;
  const handle = stringField(terminal, "handle") ?? "";
  const title = stringField(terminal, "title")?.trim() || null;
  const agentKind = process.driver.kind as AgentInfo["agent"];
  return {
    ref: {
      target,
      pid: process.pid,
      processStartedAt: process.startedAt,
      agentKind,
      sessionId: session.sessionId,
      ...(session.transcriptIdentity ? { transcriptIdentity: session.transcriptIdentity } : {}),
    },
    backend: "orca",
    agent: agentKind,
    sessionId: session.sessionId,
    ...(session.transcriptIdentity ? { transcriptIdentity: session.transcriptIdentity } : {}),
    cwd: process.cwd ?? "",
    evidence,
    pickerState,
    terminalTitle: title,
    terminalId: handle,
    displayId: title ?? target,
  };
}

function isStaleHandle(error: unknown): boolean {
  return error instanceof OrcaCliError && error.code === STALE_HANDLE;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

async function nativeExecFile(file: string, args: string[], options: { timeoutMs: number }): Promise<OrcaExecResult> {
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

async function nativeReadTranscriptHead(path: string): Promise<string> {
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

export function createOrcaRuntime(): OrcaRuntime {
  return {
    homeDir: homedir(),
    execFile: nativeExecFile,
    readFile: (path) => readFile(path, "utf8"),
    readTranscriptHead: nativeReadTranscriptHead,
  };
}

export function createOrcaBackend(bin: string): OrcaBackend {
  return new OrcaBackend(bin, createOrcaRuntime());
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );
}

export class OrcaBackend implements Terminals {
  private hookNoticesPromise: Promise<string[]> | null = null;
  private readonly processAccess: OrcaProcessAccess;
  constructor(
    private readonly bin: string,
    private readonly runtime: OrcaRuntime,
    private readonly drivers: readonly AgentDriver[] = ORCA_AGENT_DRIVERS,
  ) {
    this.processAccess = {
      homeDir: runtime.homeDir,
      readFile: (path) => runtime.readFile(path),
      readTranscriptHead: (path) => runtime.readTranscriptHead(path),
      runSystem: (file, args) => this.runSystem(file, args),
    };
  }

  private async runSystem(file: string, args: string[]): Promise<string> {
    let result: OrcaExecResult;
    try {
      result = await this.runtime.execFile(file, args, { timeoutMs: ORCA_TIMEOUT_MS });
    } catch (error) {
      throw new BackendUnavailable(errorMessage(error));
    }
    if (result.exitCode !== 0 && !lsofFoundOnlySome(file, result)) {
      throw new BackendUnavailable(resultError(result));
    }
    return result.stdout;
  }

  private async runOrca(args: string[], timeoutMs = ORCA_TIMEOUT_MS): Promise<unknown> {
    let result: OrcaExecResult;
    try {
      result = await this.runtime.execFile(this.bin, args, { timeoutMs });
    } catch (error) {
      throw new BackendUnavailable(errorMessage(error));
    }
    const envelope = parseEnvelope(result.stdout.trim() || result.stderr.trim());
    if (envelope.ok !== true) {
      const detail = object(envelope.error) ?? {};
      const code = stringField(detail, "code") ?? "orca_command_failed";
      const message = stringField(detail, "message") ?? code;
      if (code === "runtime_unavailable") throw new BackendUnavailable(message);
      throw new OrcaCliError(code, message);
    }
    if (result.exitCode !== 0) throw new BackendUnavailable(resultError(result));
    return envelope.result;
  }

  private async terminalList(): Promise<TerminalList> {
    const result = object(await this.runOrca(["terminal", "list", "--json"]));
    if (!result || !Array.isArray(result.terminals)) {
      throw new BackendUnavailable("orca terminal list returned no terminals array");
    }
    return {
      terminals: result.terminals.map(object).filter((terminal): terminal is JsonObject => terminal !== null),
      complete: result.truncated === false,
    };
  }

  private async worktreePs(): Promise<WorktreePs> {
    const result = object(await this.runOrca(["worktree", "ps", "--json"]));
    if (!result || !Array.isArray(result.worktrees)) {
      throw new BackendUnavailable("orca worktree ps returned no worktrees array");
    }
    const worktreeAgents = result.worktrees.map((worktree) => {
      const row = object(worktree);
      if (!row || !Array.isArray(row.agents)) {
        throw new BackendUnavailable("orca worktree ps returned a worktree without agents array");
      }
      return row.agents;
    });
    if (typeof result.truncated !== "boolean") {
      throw new BackendUnavailable("orca worktree ps returned no boolean truncated flag");
    }
    return {
      agents: worktreeAgents.flatMap((agents) =>
        agents.map(object).filter((agent): agent is JsonObject => agent !== null),
      ),
      truncated: result.truncated,
    };
  }

  private async processRows(withCwd: boolean): Promise<ProcessRow[]> {
    const rows = parsePsRows(await this.runSystem("ps", PS_ARGS), this.drivers);
    const candidates = rows.filter(isAgentProcess);
    if (candidates.length === 0) return rows;
    const pids = candidates.map((row) => row.pid);
    const environment = parseEnvironmentRows(
      await this.runSystem("ps", ["eww", "-o", "pid=,command=", "-p", pids.join(",")]),
    );
    for (const row of candidates) {
      const env = environment.get(row.pid);
      if (env?.paneKey) row.paneKey = env.paneKey;
      if (env?.terminalHandle) row.terminalHandle = env.terminalHandle;
      row.piCodingAgentDirSet = env?.piCodingAgentDirSet ?? false;
    }
    if (withCwd) {
      const cwd = parseLsofCwds(
        await this.runSystem("lsof", ["-a", "-p", pids.join(","), "-d", "cwd", "-Fpn"]),
      );
      for (const row of candidates) row.cwd = cwd.get(row.pid);
    }
    return rows;
  }

  private async terminalForPane(
    terminals: TerminalList,
    paneKey: string,
    process?: AgentProcessRow,
    knownRows?: readonly ProcessRow[],
  ): Promise<JsonObject | null> {
    const direct = terminalForPane(terminals, paneKey, process?.terminalHandle, knownRows);
    if (!direct.needsEnvironmentHandle || process) return direct.terminal;
    const rows = knownRows ?? (await this.processRows(false));
    const fallbackProcess = safeOuterProcess(rowsForPane(rows, paneKey), rows);
    return terminalForPane(terminals, paneKey, fallbackProcess?.terminalHandle, rows).terminal;
  }

  private async terminalShow(handle: string): Promise<JsonObject | null> {
    try {
      const result = object(await this.runOrca(["terminal", "show", "--terminal", handle, "--json"]));
      const terminal = object(result?.terminal);
      if (!terminal) throw new BackendUnavailable("orca terminal show returned no terminal object");
      return terminal;
    } catch (error) {
      if (isStaleHandle(error)) return null;
      throw error;
    }
  }

  private hookNotices(): Promise<string[]> {
    this.hookNoticesPromise ??= this.loadHookNotices().catch(() =>
      this.drivers
        .map((driver) => driver.orcaProcess?.hooks?.unavailableNotice)
        .filter((notice): notice is string => typeof notice === "string"),
    );
    return this.hookNoticesPromise;
  }

  private async loadHookNotices(): Promise<string[]> {
    const policies = this.drivers.flatMap((driver) => {
      const hooks = driver.orcaProcess?.hooks;
      return hooks ? [hooks] : [];
    });
    if (policies.length === 0) return [];
    const result = object(await this.runOrca(["agent", "hooks", "status", "--json"]));
    const statuses = Array.isArray(result?.statuses) ? result.statuses.map(object).filter((row): row is JsonObject => row !== null) : [];
    return policies.flatMap((policy) =>
      statuses.some((row) => row.agent === policy.agent && row.state === "installed") ? [] : [policy.missingNotice],
    );
  }

  private async session(process: AgentProcessRow): Promise<OrcaProcessSession | null> {
    const discovery = process.driver.orcaProcess;
    if (!discovery?.listable || !discovery.session) return null;
    const identity: OrcaProcessIdentity = {
      pid: process.pid,
      command: process.command,
      cwd: process.cwd ?? null,
      piCodingAgentDirSet: process.piCodingAgentDirSet === true,
    };
    return discovery.session(identity, this.processAccess);
  }

  async list(): Promise<ListResult> {
    const failures: ListResult["failures"] = [];
    const notices: string[] = [];
    const [terminalResult, worktreeResult, processResult, hookNotices] = await Promise.all([
      settle(this.terminalList()),
      settle(this.worktreePs()),
      settle(this.processRows(true)),
      this.hookNotices(),
    ]);
    notices.push(...hookNotices);
    if (!terminalResult.ok) failures.push({ backend: "orca", reason: errorMessage(terminalResult.error) });
    if (!worktreeResult.ok) failures.push({ backend: "orca", reason: errorMessage(worktreeResult.error) });
    if (!processResult.ok) failures.push({ backend: "orca", reason: errorMessage(processResult.error) });
    if (!terminalResult.ok || !processResult.ok) {
      return { agents: [], failures, complete: false, notices };
    }

    const terminalList = terminalResult.value;
    const worktree = worktreeResult.ok ? worktreeResult.value : null;
    const rows = processResult.value;
    const unsupportedNotices = new Set<string>();
    for (const row of rows) {
      const notice = row.driver?.orcaProcess?.unsupportedNotice;
      if (notice) unsupportedNotices.add(notice);
    }
    notices.push(...unsupportedNotices);

    const grouped = new Map<string, AgentProcessRow[]>();
    for (const row of rows) {
      if (!isAgentProcess(row) || !row.paneKey) continue;
      const group = grouped.get(row.paneKey) ?? [];
      group.push(row);
      grouped.set(row.paneKey, group);
    }

    const agents: AgentInfo[] = [];
    for (const [paneKey, candidates] of grouped) {
      const process = safeOuterProcess(candidates, rows);
      if (!process || !process.driver.orcaProcess?.listable) continue;
      if (process.startedAt === null) {
        notices.push(`orca:${paneKey}: ${process.driver.kind} process start time could not be read; skipped.`);
        continue;
      }
      const terminal = await this.terminalForPane(terminalList, paneKey, process, rows);
      if (!terminal || !usableTerminal(terminal)) continue;
      if (!process.cwd) {
        notices.push(`orca:${paneKey}: ${process.driver.kind} working directory could not be read; skipped.`);
        continue;
      }
      let session: OrcaProcessSession | null;
      try {
        session = await this.session(process);
      } catch {
        session = null;
      }
      if (!session) {
        notices.push(
          process.driver.orcaProcess?.sessionUnavailableNotice ??
            `orca:${paneKey}: セッションを特定できないため接続できません`,
        );
        continue;
      }
      const worktreeAgent = worktreeAgentForPane(worktree, paneKey);
      agents.push(
        agentInfo(
          paneKey,
          terminal,
          process,
          session,
          statusEvidence(worktreeAgent),
          worktreeAgent ? stringField(worktreeAgent, "state") : null,
        ),
      );
    }

    return {
      agents,
      failures,
      complete: failures.length === 0 && terminalList.complete && !Boolean(worktree?.truncated),
      notices,
    };
  }

  async get(target: string): Promise<AgentInfo | null> {
    const paneKey = targetPaneKey(target);
    const [terminalList, worktree, rows] = await Promise.all([this.terminalList(), this.worktreePs(), this.processRows(true)]);
    const process = safeOuterProcess(rowsForPane(rows, paneKey), rows);
    const terminal = await this.terminalForPane(terminalList, paneKey, process ?? undefined, rows);
    if (!terminal && !terminalList.complete) {
      throw new BackendUnavailable(`orca terminal list is incomplete; cannot confirm ${target} is absent`);
    }
    if (!process || !process.driver.orcaProcess?.listable || process.startedAt === null) return null;
    if (!terminal || !usableTerminal(terminal)) return null;
    const handle = stringField(terminal, "handle");
    if (!handle) return null;
    const shown = await this.terminalShow(handle);
    if (!shown || !usableTerminal(shown)) return null;
    if (!process.cwd) return null;
    let session: OrcaProcessSession | null;
    try {
      session = await this.session(process);
      if (!session) return null;
    } catch {
      return null;
    }
    const worktreeAgent = worktreeAgentForPane(worktree, paneKey);
    return agentInfo(
      paneKey,
      { ...terminal, ...shown },
      process,
      session,
      statusEvidence(worktreeAgent, shown),
      worktreeAgent ? stringField(worktreeAgent, "state") : null,
    );
  }

  async exists(target: string): Promise<boolean> {
    const paneKey = targetPaneKey(target);
    const terminals = await this.terminalList();
    const resolved = await this.terminalForPane(terminals, paneKey);
    if (!resolved && !terminals.complete) {
      throw new BackendUnavailable(`orca terminal list is incomplete; cannot confirm ${target} is absent`);
    }
    if (!resolved || !usableTerminal(resolved)) return false;
    const handle = stringField(resolved, "handle");
    if (!handle) return false;
    const shown = await this.terminalShow(handle);
    return shown !== null && usableTerminal(shown);
  }

  async read(target: string, lines: number, _region: "screen" | "history"): Promise<ScreenSnapshot> {
    if (!Number.isInteger(lines) || lines <= 0) throw new RangeError("lines must be a positive integer");
    const paneKey = targetPaneKey(target);
    const terminals = await this.terminalList();
    const resolved = await this.terminalForPane(terminals, paneKey);
    if (!resolved || !usableTerminal(resolved)) throw new UnknownTarget(`No writable Orca terminal for ${target}`);
    const handle = stringField(resolved, "handle");
    if (!handle) throw new UnknownTarget(`No writable Orca terminal for ${target}`);
    return this.readHandle(target, handle);
  }

  private async readHandle(target: string, handle: string): Promise<ScreenSnapshot> {
    let result: JsonObject | null;
    try {
      result = object(await this.runOrca(["terminal", "read", "--terminal", handle, "--screen", "--json"]));
    } catch (error) {
      if (isStaleHandle(error)) throw new UnknownTarget(`Orca terminal for ${target} is no longer available`);
      throw error;
    }
    const terminal = object(result?.terminal);
    if (!terminal) throw new BackendUnavailable("orca terminal read returned no terminal object");
    const validTail = Array.isArray(terminal.tail) && terminal.tail.every((line) => typeof line === "string");
    const tail = Array.isArray(terminal.tail)
      ? terminal.tail.filter((line): line is string => typeof line === "string")
      : [];
    return {
      text: stripSidePane(tail.join("\n")),
      draft: typeof terminal.draft === "string" ? terminal.draft : null,
      complete:
        validTail &&
        terminal.source === "screen" &&
        terminal.status === "running" &&
        // `truncated` is deliberately not read: on a screen read it is carried
        // over from Orca's stream buffer, which sets it once any output was ever
        // trimmed and never clears it, so a long-lived terminal reports it on
        // every read while the screen itself is whole. `limited === false` does
        // cover the screen (rows over the limit or characters over 32 KB).
        terminal.limited === false,
    };
  }

  async sameProcess(ref: AgentRef): Promise<boolean> {
    const paneKey = targetPaneKey(ref.target);
    if (ref.pid === null || ref.processStartedAt === null) return false;
    // Not Claude: its session id legitimately changes on /clear, so only writer-bound transcripts are rechecked.
    const bindsTranscript = ref.agentKind === "omp" || ref.agentKind === "codex";
    const rows = bindsTranscript
      ? await this.processRows(true)
      : parsePsRows(await this.runSystem("ps", PS_ARGS), this.drivers);
    const current = rows.find((row) => row.pid === ref.pid);
    if (
      !current ||
      !isAgentProcess(current) ||
      !current.driver.orcaProcess?.listable ||
      (ref.agentKind !== undefined && current.driver.kind !== ref.agentKind) ||
      current.startedAt !== ref.processStartedAt
    ) {
      return false;
    }
    const processPaneKey = bindsTranscript
      ? current.paneKey
      : parseEnvironmentRows(
          await this.runSystem("ps", ["eww", "-o", "pid=,command=", "-p", String(ref.pid)]),
        ).get(ref.pid)?.paneKey;
    if (
      processPaneKey !== paneKey ||
      !isForeground(current) ||
      hasSameTtyForegroundChild(current, rows, processMap(rows))
    ) {
      return false;
    }
    if (!bindsTranscript) return true;
    if (ref.sessionId == null || !ref.transcriptIdentity) return false;
    const session = await this.session(current);
    const identity = session?.transcriptIdentity;
    return (
      session?.sessionId === ref.sessionId &&
      identity?.path === ref.transcriptIdentity.path &&
      identity.device === ref.transcriptIdentity.device &&
      identity.inode === ref.transcriptIdentity.inode
    );
  }

  private async writableHandle(ref: AgentRef): Promise<string> {
    const terminals = await this.terminalList();
    if (!terminals.complete) throw new UnknownTarget(`Orca terminal list is incomplete for ${ref.target}`);
    const terminal = await this.terminalForPane(terminals, targetPaneKey(ref.target));
    if (!terminal || !usableTerminal(terminal)) {
      throw new UnknownTarget(`No writable Orca terminal for ${ref.target}`);
    }
    const handle = stringField(terminal, "handle");
    if (!handle) throw new UnknownTarget(`No writable Orca terminal for ${ref.target}`);
    return handle;
  }

  private async sendRaw(handle: string, args: string[], timeoutMs = ORCA_TIMEOUT_MS): Promise<JsonObject> {
    let result: JsonObject | null;
    try {
      result = object(
        await this.runOrca(["terminal", "send", "--terminal", handle, ...args, "--json"], timeoutMs),
      );
    } catch (error) {
      if (error instanceof OrcaCliError && error.code === "agent_prompt_blocked") throw error;
      throw new WriteOutcomeUnknown(error);
    }
    if (!result || object(result.send)?.accepted !== true) throw new WriteOutcomeUnknown();
    return result;
  }

  async submit(ref: AgentRef, text: string, ctx: SubmitContext): Promise<SubmitOutcome> {
    let composer: SubmitComposerState = { ...EMPTY_SUBMIT_COMPOSER_STATE };
    const refuse = (reason: SubmitRefused["reason"], message: string) => new SubmitRefused(reason, message, composer);
    const checkCancelled = () => {
      if (ctx.cancelled()) throw refuse("cancelled", "Submission was cancelled.");
    };
    if (hasUnsendableC0Controls(text)) {
      throw refuse("unsafe-text", UNSENDABLE_TEXT_MESSAGE);
    }
    checkCancelled();
    const handle = await this.writableHandle(ref);
    const read = async () => {
      const snapshot = await this.readHandle(ref.target, handle);
      return ctx.driver.recoverComposerDraft?.(snapshot) ?? snapshot;
    };
    checkCancelled();
    const initial = await read();
    checkCancelled();
    if (!initial.complete) throw refuse("incomplete-screen", "The terminal screen is incomplete.");
    const initialDraft = normalizedDraft(initial.draft);
    if (initialDraft !== null && !ctx.driver.composerProbe) {
      throw refuse("draft", "The composer contains an unsent draft.");
    }
    if (!ctx.driver.isIdleComposer?.(initial)) {
      throw refuse("not-idle", "The agent is not waiting at an empty composer.");
    }

    let finalSnapshot = initial;
    if (initialDraft !== null) {

      const readStableDraft = async (
        isPositive: (draft: string | null) => boolean,
      ): Promise<StableComposerRead | null> => {
        const deadline = Date.now() + PROBE_TIMEOUT_MS;
        let previousDraft: string | null | undefined;
        while (true) {
          checkCancelled();
          const snapshot = await read();
          checkCancelled();
          const draft = normalizedDraft(snapshot.draft);
          if (snapshot.complete && ctx.driver.isIdleComposer?.(snapshot) === true && isPositive(draft)) {
            if (previousDraft !== undefined && previousDraft === draft) return { draft, snapshot };
            previousDraft = draft;
          } else {
            previousDraft = undefined;
          }

          const remaining = deadline - Date.now();
          if (remaining <= 0) return null;
          await delay(Math.min(PROBE_POLL_MS, remaining));
        }
      };

      const writeKey = async (
        key: string,
        expectedDraft: string,
        guard: {
          notIdleReason: SubmitRefused["reason"];
          draftMismatchReason: SubmitRefused["reason"];
          beforeWrite?: () => void;
          onGate?: () => void;
        },
      ): Promise<void> => {
        checkCancelled();
        const snapshot = await read();
        checkCancelled();
        if (!snapshot.complete) throw refuse("incomplete-screen", "The terminal screen is incomplete before a probe write.");
        if (ctx.driver.isIdleComposer?.(snapshot) !== true) {
          throw refuse(guard.notIdleReason, "The composer is not idle before a probe write.");
        }
        if (normalizedDraft(snapshot.draft) !== expectedDraft) {
          throw refuse(guard.draftMismatchReason, "The composer draft changed before a probe write.");
        }

        let processIsCurrent = false;
        try {
          processIsCurrent = await this.sameProcess(ref);
        } catch {
          // An unreadable process identity is not permission to write.
        }
        if (!processIsCurrent) throw refuse("agent-changed", "The agent process changed before a probe write.");
        checkCancelled();
        guard.beforeWrite?.();
        try {
          await this.sendRaw(handle, ["--text", key]);
        } catch (error) {
          if (error instanceof OrcaCliError && error.code === "agent_prompt_blocked") {
            guard.onGate?.();
            throw refuse("gate", "Orca refused the probe write because an agent prompt is blocking.");
          }
          throw new WriteOutcomeUnknown(error, composer);
        }
      };

      const probeDraft = async (
        draft: string,
        failureReason: "probe-unverified" | "stash-unverified",
        firstWriteReasons: {
          notIdleReason: SubmitRefused["reason"];
          draftMismatchReason: SubmitRefused["reason"];
        } = { notIdleReason: failureReason, draftMismatchReason: failureReason },
      ): Promise<{ kind: "suggestion" | "typed"; snapshot: ScreenSnapshot }> => {
        const probe = draft === "x" ? "y" : "x";
        await writeKey(probe, draft, {
          ...firstWriteReasons,
          beforeWrite: () => {
            composer = { ...composer, probe };
          },
          onGate: () => {
            composer = { ...composer, probe: null };
          },
        });

        const observed = await readStableDraft((value) => value === probe || value === `${draft}${probe}`);
        if (!observed) {
          throw refuse(failureReason, "The one-character composer probe could not be verified.");
        }

        if (observed.draft === probe) {
          await writeKey("\u007f", probe, {
            notIdleReason: failureReason,
            draftMismatchReason: failureReason,
          });
          const restored = await readStableDraft((value) => value === draft || value === null);
          if (!restored) {
            throw refuse(failureReason, "The suggestion did not return after removing the probe.");
          }
          composer = { ...composer, probe: null };
          return { kind: "suggestion", snapshot: restored.snapshot };
        }

        await writeKey("\u007f", `${draft}${probe}`, {
          notIdleReason: failureReason,
          draftMismatchReason: failureReason,
        });
        const restored = await readStableDraft((value) => value === draft);
        if (!restored) {
          throw refuse(failureReason, "The typed draft did not return after removing the probe.");
        }
        composer = { ...composer, probe: null };
        return { kind: "typed", snapshot: restored.snapshot };
      };

      const initialProbe = await probeDraft(initialDraft, "probe-unverified", {
        notIdleReason: "not-idle",
        draftMismatchReason: "draft",
      });
      if (initialProbe.kind === "suggestion") {
        finalSnapshot = initialProbe.snapshot;
      } else {
        await writeKey("\u0013", initialDraft, {
          notIdleReason: "probe-unverified",
          draftMismatchReason: "probe-unverified",
          beforeWrite: () => {
            composer = { ...composer, stash: "uncertain" };
          },
          onGate: () => {
            composer = { ...composer, stash: "untouched" };
          },
        });

        const afterStash = await readStableDraft((value) => value !== initialDraft);
        if (!afterStash) {
          throw refuse("stash-unverified", "The draft was not verified out of the composer after Ctrl+S.");
        }
        composer = { ...composer, stash: "stashed" };
        if (afterStash.draft === null) {
          finalSnapshot = afterStash.snapshot;
        } else {
          const secondProbe = await probeDraft(afterStash.draft, "stash-unverified");
          if (secondProbe.kind === "typed") {
            throw refuse("stash-unverified", "A typed draft appeared after the original draft was stashed.");
          }
          finalSnapshot = secondProbe.snapshot;
        }
      }
    }
    if (!finalSnapshot.complete) throw refuse("incomplete-screen", "The final composer screen is incomplete.");
    if (!ctx.driver.isIdleComposer?.(finalSnapshot)) {
      throw refuse(
        composer.stash === "stashed" ? "stash-unverified" : "probe-unverified",
        "The final composer state is no longer idle.",
      );
    }

    checkCancelled();
    let processIsCurrent = false;
    try {
      processIsCurrent = await this.sameProcess(ref);
    } catch {
      // An unreadable process identity is not permission to write.
    }
    if (!processIsCurrent) {
      throw refuse("agent-changed", "The agent process changed before submit.");
    }
    // sameProcess is the last asynchronous check; this synchronous guard
    // catches cancellation raised while that process identity was inspected.
    checkCancelled();

    composer = { ...composer, submitUncertain: true };
    let receipt: JsonObject;
    try {
      receipt = await this.sendRaw(handle, ["--text", text, "--enter", "--wait-submit", "15"], SUBMIT_TIMEOUT_MS);
    } catch (error) {
      if (error instanceof OrcaCliError && error.code === "agent_prompt_blocked") {
        composer = { ...composer, submitUncertain: false };
        throw refuse("gate", "Orca refused the submit because an agent prompt is blocking.");
      }
      throw new WriteOutcomeUnknown(error, composer);
    }
    const stages = object(object(receipt.send)?.prompt)?.stages;
    return {
      status: Array.isArray(stages) && stages.includes("turn_started") ? "started" : "accepted",
      draftStashed: composer.stash === "stashed",
    };
  }

  private refuseOmpInput(ref: AgentRef, driverKind?: string): void {
    if (ref.agentKind === "omp" || driverKind === "omp") {
      throw new ExpectationLost("OMP input is unavailable through cctag.");
    }
  }

  openAnswer(ref: AgentRef, prompt: VerifiedPrompt): AnswerChannel {
    this.refuseOmpInput(ref, prompt.driver?.kind);
    if (ref.agentKind === "codex" || prompt.driver?.kind === "codex") {
      // Not answered from Slack: Codex 0.162 confirms an approval on its digit alone, so the
      // driver's Enter after it finds the dialog gone and the answer reads as failed.
      throw new ExpectationLost(
        "Codex prompts on Orca are answered in the terminal.",
        CODEX_ORCA_TERMINAL_ANSWER,
      );
    }
    let active = true;
    let firstWrite = true;
    const throwIfExpired = () => {
      if (prompt.expiresAt !== undefined && Date.now() >= prompt.expiresAt) {
        const message = prompt.expiredUserMessage ?? "The verified prompt expired before the answer write.";
        throw new ExpectationLost(message, prompt.expiredUserMessage);
      }
    };
    const verify = async (expectedLabel?: string): Promise<string> => {
      if (!active) throw new ExpectationLost("The answer channel is closed.");
      let handle: string;
      try {
        handle = await this.writableHandle(ref);
      } catch {
        throw new ExpectationLost("No current Orca terminal could be verified before the answer write.");
      }
      throwIfExpired();

      let snap: ScreenSnapshot;
      try {
        snap = await this.readHandle(ref.target, handle);
      } catch {
        throwIfExpired();
        throw new ExpectationLost("The Orca screen could not be read before the answer write.");
      }
      throwIfExpired();
      if (!snap.complete) throw new ExpectationLost("The Orca screen is incomplete before the answer write.");

      const blocked = prompt.driver.parseBlockedPane(snap.text);
      const reviewFingerprint = prompt.driver.parseAnswerReview?.(snap)?.fingerprint ?? null;
      const fingerprint =
        reviewFingerprint ??
        (blocked.kind === "question" || blocked.kind === "permission"
          ? blocked.verified.fingerprint
          : null);
      if (fingerprint !== prompt.fingerprint) {
        throw new ExpectationLost("The Orca prompt changed before the answer write.");
      }
      const cursorLabel = expectedLabel ?? prompt.expectedCursorLabel;
      const visibleLabel = prompt.driver.parseCursorLabel(snap);
      // Whitespace removed, not compared as is: typed text comes back wrapped and
      // broken at its newlines, and a Japanese line wraps with no space to collapse.
      if (
        cursorLabel !== undefined &&
        (visibleLabel === null || visibleLabel.replace(/\s+/g, "") !== cursorLabel.replace(/\s+/g, ""))
      ) {
        throw new ExpectationLost("The Orca cursor changed before Enter.");
      }

      let processIsCurrent = false;
      try {
        processIsCurrent = await this.sameProcess(ref);
      } catch {
        throw new ExpectationLost("The Orca process could not be verified before the answer write.");
      }
      if (!processIsCurrent) throw new ExpectationLost("The Orca process changed before the answer write.");
      return handle;
    };
    const write = async (args: string[], expectedLabel?: string, terminal = false): Promise<void> => {
      if (!active) throw new ExpectationLost("The answer channel is closed.");
      try {
        throwIfExpired();
        const handle = await verify(expectedLabel);
        throwIfExpired();
        try {
          await this.sendRaw(handle, args);
          firstWrite = false;
        } catch (error) {
          if (error instanceof OrcaCliError && error.code === "agent_prompt_blocked") {
            throw new ExpectationLost("Orca refused the answer before accepting input.");
          }
          throw error;
        }
      } catch (error) {
        active = false;
        throw error;
      }
      if (terminal) active = false;
    };

    return {
      digit: (n, terminal = prompt.form === "digit-confirms") => {
        if (!Number.isInteger(n) || n < 1 || n > 9) throw new RangeError("digit must be from 1 through 9");
        return write(["--text", String(n)], undefined, terminal);
      },
      text: async (value) => {
        if (hasUnsendableC0Controls(value)) {
          throw new ExpectationLost(UNSENDABLE_TEXT_MESSAGE, UNSENDABLE_TEXT_MESSAGE);
        }
        await write(["--text", value]);
      },
      move: async (direction, count) => {
        if (!Number.isSafeInteger(count) || count < 0) throw new RangeError("count must be a non-negative integer");
        if (count === 0) return;
        const sequence = (direction === "Up" ? "\u001b[A" : "\u001b[B").repeat(count);
        await write(["--text", sequence]);
      },
      confirm: (expectedLabel, terminal = true) => write(["--enter"], expectedLabel, terminal),
      complete: () => {
        if (!active) throw new ExpectationLost("The answer channel is closed.");
        if (firstWrite) throw new ExpectationLost("The answer channel cannot complete before its first write.");
        active = false;
      },
    };
  }


  openModelAnswer(ref: AgentRef, prompt: VerifiedModelMenuPrompt): ModelAnswerChannel {
    this.refuseOmpInput(ref, prompt.driver?.kind);
    throw new ExpectationLost("Orca does not support Codex's Escape model menu; Claude /model commands use submit.");
  }

  openBlind(ref: AgentRef, prompt: BlindPermissionPrompt): BlindChannel {
    this.refuseOmpInput(ref, prompt.driver?.kind);
    if (prompt.form !== "key-confirms") {
      throw new ExpectationLost("Orca has no verified blind confirmation that needs an Enter.");
    }
    let attempted = false;
    return {
      answer: async (choice) => {
        if (attempted) throw new ExpectationLost("The blind confirmation channel has already been used.");
        attempted = true;
        const current = await this.get(ref.target);
        const evidence = current?.evidence;
        // Not state === "waiting" alone: no Claude permission prompt is captured on
        // Orca, and one reported as a null state with agentWait.since would
        // otherwise refuse every blind answer.
        const waiting =
          evidence?.kind === "hint" &&
          (evidence.state === "waiting" || (evidence.state === null && evidence.waitingSince !== null));
        if (!waiting) {
          throw new ExpectationLost("Orca no longer reports the agent waiting for the blind confirmation.");
        }
        const handle = await this.writableHandle(ref);
        const snap = await this.readHandle(ref.target, handle);
        if (!snap.complete) throw new ExpectationLost("The Orca screen is incomplete before the blind confirmation.");
        // Not openAnswer's fingerprint re-check: a blind prompt is one the driver
        // could not parse, so there is no fingerprint to compare.
        if (prompt.driver.isIdleComposer?.(snap)) {
          throw new ExpectationLost("The blind confirmation is no longer on screen.");
        }
        if (!(await this.sameProcess(ref))) {
          throw new ExpectationLost("The Orca process changed before the blind confirmation.");
        }
        try {
          await this.sendRaw(handle, ["--text", choice]);
        } catch (error) {
          if (error instanceof OrcaCliError && error.code === "agent_prompt_blocked") {
            throw new ExpectationLost("Orca refused the blind confirmation before accepting input.");
          }
          throw error;
        }
      },
    };
  }

  openComposer(ref: AgentRef, driver: AgentDriver): ComposerChannel {
    this.refuseOmpInput(ref, driver.kind);
    let attempted = false;
    return {
      backTab: async () => {
        if (attempted) throw new ExpectationLost("The composer channel has already been used.");
        attempted = true;
        const handle = await this.writableHandle(ref);
        const read = await this.readHandle(ref.target, handle);
        const snap = driver.recoverComposerDraft?.(read) ?? read;
        if (!snap.complete) throw new ExpectationLost("The Orca screen is incomplete before the composer write.");
        if (!driver.isIdleComposer?.(snap)) {
          throw new ExpectationLost("The Orca composer is not idle.");
        }
        if (snap.draft !== null && snap.draft !== "") {
          throw new ExpectationLost("The Orca composer contains an unsent draft.");
        }
        if (!(await this.sameProcess(ref))) {
          throw new ExpectationLost("The Orca process changed before the composer write.");
        }
        try {
          await this.sendRaw(handle, ["--text", "\u001b[Z"]);
        } catch (error) {
          if (error instanceof OrcaCliError && error.code === "agent_prompt_blocked") {
            throw new ExpectationLost("Orca refused the composer write before accepting input.");
          }
          throw error;
        }
      },
    };
  }
}
