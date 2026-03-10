import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { truncLabel, chunk } from "./picker-utils.js";

describe("truncLabel", () => {
  it("returns short strings unchanged", () => {
    assert.equal(truncLabel("hello"), "hello");
  });

  it("truncates strings exceeding max", () => {
    const long = "a".repeat(70);
    const result = truncLabel(long, 60);
    assert.equal(result.length, 60);
    assert.ok(result.endsWith("…"));
  });

  it("uses default max of 60", () => {
    const exactly60 = "a".repeat(60);
    assert.equal(truncLabel(exactly60), exactly60);
    assert.ok(truncLabel("a".repeat(61)).endsWith("…"));
  });
});

describe("chunk", () => {
  it("splits array into chunks of given size", () => {
    assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  });

  it("returns single chunk for small arrays", () => {
    assert.deepEqual(chunk([1, 2], 5), [[1, 2]]);
  });

  it("returns empty array for empty input", () => {
    assert.deepEqual(chunk([], 3), []);
  });
});
