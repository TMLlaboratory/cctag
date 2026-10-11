import { test } from "node:test";
import assert from "node:assert/strict";
import { setBounded } from "./bounded.js";

test("setBounded keeps the newest entries and drops the oldest", () => {
  const map = new Map<string, number>();
  for (let i = 1; i <= 5; i++) setBounded(map, `m${i}`, i, 3);
  assert.deepEqual([...map.keys()], ["m3", "m4", "m5"]);
});

test("setBounded leaves a map under its cap untouched", () => {
  const map = new Map([["a", 1]]);
  setBounded(map, "b", 2, 3);
  assert.deepEqual([...map.entries()], [["a", 1], ["b", 2]]);
});

test("setBounded overwrites an existing key without growing the map", () => {
  const map = new Map([["a", 1], ["b", 2]]);
  setBounded(map, "a", 9, 2);
  assert.deepEqual([...map.entries()], [["a", 9], ["b", 2]]);
});
