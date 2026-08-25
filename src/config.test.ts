import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONFIG_TEMPLATE,
  REQUIRED_ENV_KEYS,
  assertExplicitEnvFileExists,
  parsePositiveNumber,
  resolveEnvFile,
} from "./config.js";

function withEnv(value: string | undefined, run: () => void): void {
  const key = "CCTAG_TEST_LIMIT";
  const previous = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

test("parsePositiveNumber falls back when unset or blank", () => {
  withEnv(undefined, () => assert.equal(parsePositiveNumber("CCTAG_TEST_LIMIT", 8), 8));
  // Number("") is 0, which as a cap would reject every file — treat it as unset.
  withEnv("", () => assert.equal(parsePositiveNumber("CCTAG_TEST_LIMIT", 8), 8));
  withEnv("   ", () => assert.equal(parsePositiveNumber("CCTAG_TEST_LIMIT", 8), 8));
});

test("parsePositiveNumber rejects a value that would silently disable the cap", () => {
  // The reported failure: Number("8MB") is NaN and `size > NaN` is always
  // false, so a plausible-looking typo removes the limit entirely.
  withEnv("8MB", () => assert.throws(() => parsePositiveNumber("CCTAG_TEST_LIMIT", 8), /must be a positive number/));
  withEnv("abc", () => assert.throws(() => parsePositiveNumber("CCTAG_TEST_LIMIT", 8), /must be a positive number/));
  withEnv("0", () => assert.throws(() => parsePositiveNumber("CCTAG_TEST_LIMIT", 8), /must be a positive number/));
  withEnv("-4", () => assert.throws(() => parsePositiveNumber("CCTAG_TEST_LIMIT", 8), /must be a positive number/));
  withEnv("Infinity", () => assert.throws(() => parsePositiveNumber("CCTAG_TEST_LIMIT", 8), /must be a positive number/));
});

test("the timing knobs reject a unit-suffixed value instead of silently disabling themselves", () => {
  // These two were on a raw Number() long after the file caps were fixed, and
  // they are the likeliest to be written with their unit: both names end in
  // _MS. NaN then fails in the unsafe direction — `elapsed > NaN` is false so a
  // turn never times out, and setTimeout(NaN) fires after 1ms, which turns the
  // poll loop into a hot loop against herdr.
  for (const name of ["CCTAG_TURN_TIMEOUT_MS", "CCTAG_POLL_INTERVAL_MS", "CCTAG_HUB_PORT"]) {
    const previous = process.env[name];
    process.env[name] = name === "CCTAG_HUB_PORT" ? "8765番" : "20m";
    try {
      assert.throws(() => parsePositiveNumber(name, 1_000), /must be a positive number/, `${name} must be validated`);
    } finally {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  }
});

test("parsePositiveNumber enforces whole numbers where required", () => {
  withEnv("2.5", () => assert.equal(parsePositiveNumber("CCTAG_TEST_LIMIT", 8), 2.5, "sizes may be fractional"));
  withEnv("2.5", () =>
    assert.throws(() => parsePositiveNumber("CCTAG_TEST_LIMIT", 5, { integer: true }), /must be a whole number/),
  );
  withEnv("3", () => assert.equal(parsePositiveNumber("CCTAG_TEST_LIMIT", 5, { integer: true }), 3));
});

test("each knob is validated against its real domain, not just positivity", () => {
  // Codex review, Moderate 3. Every case below is a positive finite number that
  // still misbehaves silently rather than loudly, which is why "positive" alone
  // was not enough.
  const cases: Array<{ value: string; opts: Parameters<typeof parsePositiveNumber>[2]; why: string }> = [
    // 1e308 passes as finite here, then overflows to Infinity once multiplied
    // into bytes — a cap that compares false against every size.
    { value: "1e308", opts: { max: 1024 }, why: "file cap must stay multipliable into bytes" },
    // Node coerces any delay past 2^31-1 to 1ms, so the longest interval anyone
    // could type behaves like the shortest.
    { value: "2147483648", opts: { integer: true, min: 100, max: 2_147_483_647 }, why: "timer overflow" },
    // A plausible way to write "half a second" that would poll ~2000x faster.
    { value: "0.5", opts: { integer: true, min: 100, max: 2_147_483_647 }, why: "sub-ms poll interval" },
    { value: "70000", opts: { integer: true, min: 1, max: 65_535 }, why: "port out of range" },
  ];

  for (const { value, opts, why } of cases) {
    const previous = process.env.CCTAG_TEST_LIMIT;
    process.env.CCTAG_TEST_LIMIT = value;
    try {
      assert.throws(
        () => parsePositiveNumber("CCTAG_TEST_LIMIT", 1_000, opts),
        /must be (at least|at most|a whole number)/,
        `${value} should be rejected (${why})`,
      );
    } finally {
      if (previous === undefined) delete process.env.CCTAG_TEST_LIMIT;
      else process.env.CCTAG_TEST_LIMIT = previous;
    }
  }
});

test("values inside the domain still pass, and an unset var still falls back", () => {
  withEnv("2000", () =>
    assert.equal(parsePositiveNumber("CCTAG_TEST_LIMIT", 1_500, { integer: true, min: 100, max: 2_147_483_647 }), 2000),
  );
  withEnv("10", () => assert.equal(parsePositiveNumber("CCTAG_TEST_LIMIT", 10, { max: 1024 }), 10));
  withEnv(undefined, () => assert.equal(parsePositiveNumber("CCTAG_TEST_LIMIT", 8765, { min: 1, max: 65_535 }), 8765));
});

test("resolveEnvFile reads the first match: path 1 beats path 2 beats path 3", () => {
  const existsEverywhere = () => true;
  const existsNowhere = () => false;

  // All three exist — path 1 (CCTAG_ENV_FILE) wins.
  assert.equal(resolveEnvFile(["/a", "/b", "/c"], existsEverywhere), "/a");
  // Path 1 unset (undefined, same as CCTAG_ENV_FILE not being set) — path 2 wins.
  assert.equal(resolveEnvFile([undefined, "/b", "/c"], existsEverywhere), "/b");
  // Only path 3 exists.
  assert.equal(
    resolveEnvFile(["/a", "/b", "/c"], (p) => p === "/c"),
    "/c",
  );
  // Path 1 is set but the file doesn't exist — falls through to path 2, not
  // an error. True of this generic, candidate-agnostic resolver in
  // isolation; the real CCTAG_ENV_FILE call site no longer relies on this
  // for path 1 specifically — see assertExplicitEnvFileExists below, which
  // is checked before this function ever runs.
  assert.equal(
    resolveEnvFile(["/a", "/b", "/c"], (p) => p !== "/a"),
    "/b",
  );
  // Nothing exists anywhere — not an error, just no match.
  assert.equal(resolveEnvFile(["/a", "/b", "/c"], existsNowhere), undefined);
  assert.equal(resolveEnvFile([undefined, undefined, undefined], existsEverywhere), undefined);
});

test("assertExplicitEnvFileExists is a no-op when CCTAG_ENV_FILE is unset or points at a real file", () => {
  assert.doesNotThrow(() => assertExplicitEnvFileExists(undefined, () => false));
  assert.doesNotThrow(() => assertExplicitEnvFileExists("/real", () => true));
});

test("assertExplicitEnvFileExists treats an empty string the same as unset", () => {
  // CCTAG_ENV_FILE= is the shell idiom for clearing a variable back to its
  // default for one invocation; it must fall back to the XDG/cwd defaults
  // like an unset CCTAG_ENV_FILE, not throw.
  assert.doesNotThrow(() => assertExplicitEnvFileExists("", () => false));
});

test("assertExplicitEnvFileExists throws instead of silently falling back when the explicit path is missing", () => {
  // The failure this guards against: CCTAG_ENV_FILE is typo'd or the file
  // moved, and the process quietly reads ~/.config/cctag/config.env or
  // ./.env instead. On a machine running one Spoke per Slack workspace
  // (each pointed at a different CCTAG_ENV_FILE), that can start an
  // instance against the wrong workspace's credentials instead of failing
  // loudly.
  assert.throws(() => assertExplicitEnvFileExists("/missing", () => false), /CCTAG_ENV_FILE/);
});

test("the embedded config template stays in sync with every key required() demands", () => {
  // The template and .env.example will drift apart over time unless
  // something enforces it — this is that something. A template missing a
  // required key would crash with "Missing required environment variable"
  // right after telling the user they were done.
  for (const key of REQUIRED_ENV_KEYS) {
    assert.match(
      CONFIG_TEMPLATE,
      new RegExp(`^${key}=`, "m"),
      `CONFIG_TEMPLATE is missing required key ${key}`,
    );
  }
});
