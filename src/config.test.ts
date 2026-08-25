import { test } from "node:test";
import assert from "node:assert/strict";
import { hubSlug, parsePositiveNumber } from "./config.js";

test("hubSlug ignores a trailing slash, matching wsUrlFor's own normalization", () => {
  // https://hub and https://hub/ are the same Hub; they must share one
  // lock file and one pairing store, or two Spokes pointed at the "same"
  // Hub (one with a trailing slash, one without) would fail to see each
  // other and reproduce the fight-forever bug this namespacing prevents.
  assert.equal(hubSlug("https://hub"), hubSlug("https://hub/"));
  assert.equal(hubSlug("https://hub///"), hubSlug("https://hub"));
});

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
