import { describe, expect, it } from "vitest";
import { isControlCodePoint } from "../text.js";

describe("text helpers", () => {
  it("recognizes C0 and DEL control code points", () => {
    expect(isControlCodePoint(0)).toBe(true);
    expect(isControlCodePoint(31)).toBe(true);
    expect(isControlCodePoint(32)).toBe(false);
    expect(isControlCodePoint(126)).toBe(false);
    expect(isControlCodePoint(127)).toBe(true);
    expect(isControlCodePoint(128)).toBe(false);
  });
});
