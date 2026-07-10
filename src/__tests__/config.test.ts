import { describe, expect, it } from "vitest";
import { parseSizeBytes } from "../config.js";

describe("parseSizeBytes", () => {
  it("rejects numeric strings outside the safe integer range", () => {
    expect(() => parseSizeBytes("9007199254740992", 1, "size")).toThrow(
      "must be a positive number",
    );
  });
});
