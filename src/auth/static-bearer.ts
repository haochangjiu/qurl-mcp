import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { QURLClient } from "../client.js";

export const PASSTHROUGH_BEARER_CLIENT_ID = "passthrough-bearer-client";

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
        expiresAt: 4102444800,
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
