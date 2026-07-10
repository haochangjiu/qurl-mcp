import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { QURLClient } from "../client.js";

const PASSTHROUGH_BEARER_CLIENT_ID = "qurl-api-key";

export interface PassthroughBearerAuthConfig {
  qurlApiUrl: string;
}

export function createPassthroughBearerVerifier(): {
  verifyAccessToken(token: string): Promise<AuthInfo>;
} {
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const qurlApiKey = token.trim();
      if (!qurlApiKey) {
        throw new Error("Invalid or expired token.");
      }

      return {
        token: qurlApiKey,
        clientId: PASSTHROUGH_BEARER_CLIENT_ID,
        scopes: ["mcp:tools"],
        // The downstream qURL API remains the authority for key expiry and
        // revocation. This verifier only establishes the per-request key.
        expiresAt: 4102444800,
      };
    },
  };
}

export function createQurlClientFromBearerToken(
  token: string,
  config: PassthroughBearerAuthConfig,
): QURLClient {
  return new QURLClient({
    apiKey: token.trim(),
    baseURL: config.qurlApiUrl,
  });
}
