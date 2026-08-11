import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePositiveNumber } from "./config.js";

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
