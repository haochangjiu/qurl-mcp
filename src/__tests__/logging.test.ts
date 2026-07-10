import { afterEach, describe, expect, it, vi } from "vitest";
import { logInfo } from "../logging.js";

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
});
