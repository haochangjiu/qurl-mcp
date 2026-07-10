import { describe, expect, it } from "vitest";
import { parseSizeBytes } from "../config.js";

describe("parseSizeBytes", () => {
  it("parses byte units and uses the fallback only when unset", () => {
    expect(parseSizeBytes(undefined, 42, "size")).toBe(42);
    expect(parseSizeBytes("16b", 1, "size")).toBe(16);
    expect(parseSizeBytes("2kb", 1, "size")).toBe(2 * 1024);
    expect(parseSizeBytes("1.5mb", 1, "size")).toBe(1.5 * 1024 * 1024);
  });

  it("rejects zero, negative, and malformed sizes", () => {
    expect(() => parseSizeBytes(0, 1, "size")).toThrow("positive number");
    expect(() => parseSizeBytes(-1, 1, "size")).toThrow("positive number");
    expect(() => parseSizeBytes("0mb", 1, "size")).toThrow("positive byte size");
    expect(() => parseSizeBytes("many", 1, "size")).toThrow("positive byte size");
  });

  it("rejects numeric strings outside the safe integer range", () => {
    expect(() => parseSizeBytes("9007199254740992", 1, "size")).toThrow(
      "must be a positive number",
    );
  });
});
