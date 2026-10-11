import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PairingStore, type Pairing } from "../pairing.js";
import { createTerminals, type SubmitContext, type Terminals } from "./index.js";
import { BackendUnavailable, UnknownTarget, type AgentInfo, type AgentRef } from "./types.js";

const PANE = "wT:p1";

function agent(target: string, backend: AgentInfo["backend"] = "herdr"): AgentInfo {
  return {
    ref: { target, pid: null, processStartedAt: null },
    backend,
    agent: "claude",
    sessionId: "s1",
    cwd: "/tmp/project",
    evidence: { kind: "classified", status: "idle" },
    terminalTitle: null,
    terminalId: "herdr-terminal-id",
    displayId: target,
  };
}

function herdr(overrides: Partial<Terminals> = {}): Terminals {
  return {
    async list() {
      return { agents: [], failures: [], complete: true, notices: [] };
    },
    async get() {
      return null;
    },
    async exists() {
      return true;
    },
    async read() {
      return { text: "", draft: null, complete: true };
    },
    async submit() {
      return { status: "accepted", draftStashed: false };
    },
    openAnswer() {
      return {
        async digit() {},
        async text() {},
        async move() {},
        async confirm() {},
        complete() {},
      };
    },
    openModelAnswer() {
      return {
        async digit() {},
        async text() {},
        async move() {},
        async confirm() {},
        complete() {},
        async escape() {},
      };
    },
    openBlind() {
      return { async answer() {} };
    },
    openComposer() {
      return { async backTab() {} };
    },
    ...overrides,
  };
}

test("unprefixed Herdr IDs are passed through unchanged", async () => {
  let received: string | undefined;
  const terminals = createTerminals({
    herdr: herdr({
      async get(target) {
        received = target;
        return agent(target);
      },
    }),
    orca: null,
  });

  const result = await terminals.get(PANE);
  assert.equal(received, PANE);
  assert.equal(result?.ref.target, PANE);
});

test("answer, model, and composer channels route to Herdr without changing the reference", () => {
  const ref: AgentRef = { target: PANE, pid: null, processStartedAt: null };
  const answer = {
    async digit() {},
    async text() {},
    async move() {},
    async confirm() {},
    complete() {},
  };
  const modelAnswer = {
    async digit() {},
    async text() {},
    async move() {},
    async confirm() {},
    complete() {},
    async escape() {},
  };
  const blind = { async answer() {} };
  const composer = { async backTab() {} };
  const terminals = createTerminals({
    herdr: herdr({
      openModelAnswer(received) {
        assert.equal(received, ref);
        return modelAnswer;
      },
      openAnswer(received) {
        assert.equal(received, ref);
        return answer;
      },
      openBlind(received) {
        assert.equal(received, ref);
        return blind;
      },
      openComposer(received) {
        assert.equal(received, ref);
        return composer;
      },
    }),
    orca: null,
  });

  assert.equal(terminals.openAnswer(ref, {} as never), answer);
  assert.equal(terminals.openModelAnswer(ref, {} as never), modelAnswer);
  assert.equal(terminals.openBlind(ref, {} as never), blind);
  assert.equal(terminals.openComposer(ref, {} as never), composer);
});

test("orca targets fail closed before reaching the Herdr backend", async () => {
  const calls: string[] = [];
  const terminals = createTerminals({
    herdr: herdr({
      async get(target) {
        calls.push(`get:${target}`);
        return null;
      },
      async exists(target) {
        calls.push(`exists:${target}`);
        return false;
      },
      async read(target) {
        calls.push(`read:${target}`);
        return { text: "", draft: null, complete: true };
      },
      async submit(ref: AgentRef, _text: string, _ctx: SubmitContext) {
        calls.push(`submit:${ref.target}`);
        return { status: "accepted", draftStashed: false };
      },
    }),
    orca: null,
  });
  const target = "orca:42";

  await assert.rejects(terminals.get(target), UnknownTarget);
  assert.throws(() => terminals.exists(target), UnknownTarget);
  assert.throws(() => terminals.read(target, 20, "screen"), UnknownTarget);
  assert.throws(
    () => terminals.submit({ target, pid: 42, processStartedAt: 1 }, "hello", {} as SubmitContext),
    UnknownTarget,
  );
  const ref: AgentRef = { target, pid: 42, processStartedAt: 1 };
  assert.deepEqual(calls, []);
  assert.throws(() => terminals.openAnswer(ref, {} as never), UnknownTarget);
  assert.throws(() => terminals.openModelAnswer(ref, {} as never), UnknownTarget);
  assert.throws(() => terminals.openBlind(ref, {} as never), UnknownTarget);
  assert.throws(() => terminals.openComposer(ref, {} as never), UnknownTarget);
});
test("enabled Orca routes explicitly and list combines backend results", async () => {
  const target = "orca:tab-1:leaf-2";
  const calls: string[] = [];
  const terminals = createTerminals({
    herdr: herdr({
      async list() {
        return { agents: [agent(PANE)], failures: [], complete: true, notices: [] };
      },
    }),
    orca: herdr({
      async list() {
        return {
          agents: [agent(target, "orca")],
          failures: [{ backend: "orca", reason: "partial" }],
          complete: false,
          notices: ["hook notice"],
        };
      },
      async get(received) {
        calls.push(`get:${received}`);
        return agent(received, "orca");
      },
      async exists(received) {
        calls.push(`exists:${received}`);
        return true;
      },
      async read(received) {
        calls.push(`read:${received}`);
        return { text: "screen", draft: null, complete: true };
      },
    }),
  });

  const listed = await terminals.list();
  assert.deepEqual(listed.agents.map((item) => item.ref.target), [PANE, target]);
  assert.deepEqual(listed.failures, [{ backend: "orca", reason: "partial" }]);
  assert.equal(listed.complete, false);
  assert.deepEqual(listed.notices, ["hook notice"]);
  assert.equal((await terminals.get(target))?.backend, "orca");
  assert.equal(await terminals.exists(target), true);
  assert.deepEqual(await terminals.read(target, 20, "screen"), { text: "screen", draft: null, complete: true });
  assert.deepEqual(calls, [`get:${target}`, `exists:${target}`, `read:${target}`]);

  const orcaOnly = createTerminals({ herdr: null, orca: herdr() });
  await assert.rejects(orcaOnly.get(PANE), UnknownTarget);
});


test("a Herdr result in the reserved Orca namespace raises a collision error", async () => {
  const terminals = createTerminals({
    herdr: herdr({
      async get() {
        return agent("orca:herdr-collision");
      },
    }),
    orca: null,
  });

  await assert.rejects(terminals.get(PANE), BackendUnavailable);
});

test("a pairing file without a backend field still loads and routes to Herdr", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cctag-legacy-pairing-"));
  try {
    const path = join(dir, "pairings.json");
    writeFileSync(
      path,
      JSON.stringify([
        {
          key: "C1:1.1",
          channel: "C1",
          threadTs: "1.1",
          paneId: PANE,
          terminalId: "term_legacy",
          cwd: "/tmp/project",
          pairedBy: "U1",
          pairedAt: "2026-01-01T00:00:00.000Z",
        },
      ]),
    );
    const pairings = new PairingStore(path);
    const pairing = pairings.get("C1", "1.1");
    assert.ok(pairing);
    assert.equal("backend" in pairing, false);

    const received: string[] = [];
    const terminals = createTerminals({
      herdr: herdr({
        async get(target) {
          received.push(target);
          return agent(target);
        },
      }),
      orca: null,
    });
    const result = await terminals.get(pairing.paneId);
    assert.deepEqual(received, [PANE]);
    assert.equal(result?.backend, "herdr");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Orca pairing round-trips its namespaced target and backend without a PID", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cctag-orca-pairing-"));
  try {
    const path = join(dir, "pairings.json");
    const target = "orca:tab-7:leaf-2";
    const pairing: Pairing = {
      key: "C1:1.1",
      channel: "C1",
      threadTs: "1.1",
      paneId: target,
      backend: "orca",
      terminalId: "orca-tab-7",
      cwd: "/tmp/project",
      pairedBy: "U1",
      pairedAt: "2026-01-01T00:00:00.000Z",
    };
    const store = new PairingStore(path);
    store.add(pairing);

    const saved = JSON.parse(readFileSync(path, "utf8")) as Array<Record<string, unknown>>;
    assert.equal(saved[0].paneId, target);
    assert.equal(saved[0].backend, "orca");
    assert.equal("pid" in saved[0], false);

    const restored = new PairingStore(path).get("C1", "1.1");
    assert.ok(restored);
    assert.equal(restored.paneId, target);
    assert.equal(restored.backend, "orca");

    const received: string[] = [];
    const terminals = createTerminals({
      herdr: herdr(),
      orca: herdr({
        async get(receivedTarget) {
          received.push(receivedTarget);
          return agent(receivedTarget, "orca");
        },
      }),
    });
    const live = await terminals.get(restored.paneId);
    assert.deepEqual(received, [target]);
    assert.equal(live?.backend, "orca");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pairing store normalizes backend tags from target prefixes and warns on mismatches", () => {
  const dir = mkdtempSync(join(tmpdir(), "cctag-pairing-prefix-"));
  const path = join(dir, "pairings.json");
  const common = {
    channel: "C1",
    terminalId: "term_1",
    cwd: "/tmp/project",
    pairedBy: "U1",
    pairedAt: "2026-01-01T00:00:00.000Z",
  };
  writeFileSync(
    path,
    JSON.stringify([
      { ...common, key: "C1:1.1", threadTs: "1.1", paneId: "orca:tab-7:leaf-2" },
      { ...common, key: "C1:2.1", threadTs: "2.1", paneId: "wT:p2", backend: "orca" },
    ]),
  );

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
  try {
    const store = new PairingStore(path);
    const orcaPairing = store.get("C1", "1.1");
    const herdrPairing = store.get("C1", "2.1");
    assert.equal(orcaPairing?.backend, "orca");
    assert.ok(herdrPairing);
    assert.equal("backend" in herdrPairing, false);
    assert.equal(warnings.length, 2);

    store.add({
      ...herdrPairing,
      key: "C1:3.1",
      threadTs: "3.1",
      paneId: "orca:tab-8:leaf-1",
      backend: undefined,
    });
    store.add({
      ...herdrPairing,
      key: "C1:4.1",
      threadTs: "4.1",
      paneId: "wT:p3",
      backend: "orca",
    });

    const saved = JSON.parse(readFileSync(path, "utf8")) as Array<Record<string, unknown>>;
    assert.equal(saved.find((pairing) => pairing.key === "C1:3.1")?.backend, "orca");
    assert.equal("backend" in saved.find((pairing) => pairing.key === "C1:4.1")!, false);
    assert.equal(warnings.length, 2, "new canonical records do not warn");
  } finally {
    console.warn = originalWarn;
    rmSync(dir, { recursive: true, force: true });
  }
});
