import { describe, expect, it } from "vitest";
import { createPassthroughBearerVerifier } from "../../auth/static-bearer.js";

describe("passthrough bearer verifier", () => {
  it("rejects empty bearer tokens", async () => {
    const verifier = createPassthroughBearerVerifier();
    await expect(verifier.verifyAccessToken("   ")).rejects.toThrow("Invalid or expired token");
  });

  it("normalizes the caller's qURL API key", async () => {
    const verifier = createPassthroughBearerVerifier();
    const auth = await verifier.verifyAccessToken("  lv_live_test  ");

    expect(auth.token).toBe("lv_live_test");
    expect(auth.clientId).toBe("qurl-api-key");
    expect(auth.scopes).toEqual(["mcp:tools"]);
  });
});
