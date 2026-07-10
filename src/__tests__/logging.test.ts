import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatErrorForLog,
  logInfo,
  sanitizeConsoleArgument,
  sanitizeLogValue,
} from "../logging.js";

describe("logging", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("writes server timestamps in UTC", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T06:30:45.123Z"));
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    logInfo("ready");

    expect(write).toHaveBeenCalledWith("2026-07-10 06:30:45.123 UTC ready\n");
  });

  it("redacts credentials from informational logs", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T06:30:45.123Z"));
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    logInfo("request Bearer secret-token used lv_live_secret");

    expect(write).toHaveBeenCalledWith(
      "2026-07-10 06:30:45.123 UTC request Bearer [REDACTED] used [REDACTED]\n",
    );
  });

  it("redacts credentials and flattens untrusted error text", () => {
    expect(sanitizeLogValue("Bearer secret-token\nlv_live_secret")).toBe(
      "Bearer [REDACTED] [REDACTED]",
    );
    expect(formatErrorForLog(new Error("failed with lv_live_secret\r\nnext"))).toBe(
      "Error: failed with [REDACTED]  next",
    );
    expect(sanitizeLogValue("prefixlv_live_secret suffix")).toBe("prefix[REDACTED] suffix");
    expect(sanitizeConsoleArgument({ token: "lv_live_secret" })).toBe("[object Object]");
  });
});
