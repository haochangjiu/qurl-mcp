import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { QURLClient } from "../client.js";

export const PASSTHROUGH_BEARER_CLIENT_ID = "passthrough-bearer-client";
export const PASSTHROUGH_BEARER_USER_ID = "passthrough-bearer-user";

export interface PassthroughBearerAuthConfig {
  qurlApiUrl: string;
}

function maskToken(token: string): string {
  if (token.length <= 10) return `${token.slice(0, 2)}***`;
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

export function createPassthroughBearerVerifier(config: PassthroughBearerAuthConfig): {
  verifyAccessToken(token: string): Promise<AuthInfo>;
} {
  const qurlApiUrl = config.qurlApiUrl.trim();

  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const qurlApiKey = token.trim();
      if (!qurlApiKey) {
        console.warn("[mcp-auth] rejected request: empty bearer token");
        throw new Error("Invalid or expired token.");
      }

      return {
        token,
        clientId: PASSTHROUGH_BEARER_CLIENT_ID,
        scopes: ["mcp:tools"],
        expiresAt: 4102444800,
        extra: {
          qurlApiKey,
          qurlApiUrl,
          qurlUserId: PASSTHROUGH_BEARER_USER_ID,
        },
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
