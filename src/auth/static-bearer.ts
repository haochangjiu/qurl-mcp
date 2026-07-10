import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { QURLClient } from "../client.js";

// This is intentionally shared, non-secret MCP metadata rather than an
// authorization boundary. HTTP sessions are isolated by their bearer-token
// digest and a separate per-session qURL client.
export const PASSTHROUGH_BEARER_CLIENT_ID = "passthrough-bearer-client";
// The MCP SDK requires an expiry for bearer middleware. Actual qURL key
// expiry/revocation is enforced by the downstream API, so use a distant
// sentinel rather than pretending to know the key's real expiry.
const DOWNSTREAM_VALIDATED_TOKEN_EXPIRY = 4_102_444_800;

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
        console.warn("[mcp-auth] rejected request: empty bearer token");
        throw new InvalidTokenError("Invalid or expired token.");
      }

      return {
        token: qurlApiKey,
        clientId: PASSTHROUGH_BEARER_CLIENT_ID,
        scopes: ["mcp:tools"],
        expiresAt: DOWNSTREAM_VALIDATED_TOKEN_EXPIRY,
      };
    },
  };
}

export function createQurlClientFromBearerToken(
  token: string,
  config: Pick<PassthroughBearerAuthConfig, "qurlApiUrl">,
): QURLClient {
  return new QURLClient({
    apiKey: token.trim(),
    baseURL: config.qurlApiUrl.trim(),
  });
}
