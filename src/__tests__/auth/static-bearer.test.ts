import { describe, expect, it } from "vitest";
import {
  createPassthroughBearerVerifier,
  PASSTHROUGH_BEARER_CLIENT_ID,
} from "../../auth/static-bearer.js";

describe("passthrough bearer authentication", () => {
  const verifier = createPassthroughBearerVerifier({
    qurlApiUrl: " https://api.layerv.ai/ ",
  });

  it("rejects an empty bearer token", async () => {
    await expect(verifier.verifyAccessToken("   ")).rejects.toThrow("Invalid or expired token.");
  });

  it("stores the caller's qURL API key in the authenticated request context", async () => {
    const auth = await verifier.verifyAccessToken("  lv_live_test  ");

    expect(auth.clientId).toBe(PASSTHROUGH_BEARER_CLIENT_ID);
    expect(auth.scopes).toContain("mcp:tools");
    expect(auth.extra).toEqual(
      expect.objectContaining({
        qurlApiKey: "lv_live_test",
        qurlApiUrl: "https://api.layerv.ai/",
      }),
    );
  });
});
