import { describe, expect, it } from "vitest";
import { loadHttpServerConfig } from "../http-config.js";

describe("HTTP server config", () => {
  it("defaults to a loopback-only listener", () => {
    const config = loadHttpServerConfig({});
    expect(config).toEqual(
      expect.objectContaining({
        host: "127.0.0.1",
        port: 3000,
        trustProxyHops: 0,
        qurlApiUrl: "https://api.layerv.ai",
      }),
    );
  });

  it("requires an allowlist for non-loopback bindings", () => {
    expect(() => loadHttpServerConfig({ MCP_HOST: "0.0.0.0" })).toThrow(
      "MCP_ALLOWED_HOSTS is required",
    );
  });

  it("parses bounded proxy, rate, body, and listener settings", () => {
    const config = loadHttpServerConfig({
      MCP_HOST: "0.0.0.0",
      MCP_PORT: "8080",
      MCP_ALLOWED_HOSTS: "MCP.Example.com,localhost,mcp.example.com",
      MCP_TRUST_PROXY_HOPS: "1",
      MCP_MAX_JSON_BODY_BYTES: "2048",
      MCP_RATE_LIMIT_PER_MINUTE: "60",
      QURL_API_URL: "https://api.example.com/v1",
    });

    expect(config).toEqual({
      host: "0.0.0.0",
      port: 8080,
      allowedHosts: ["mcp.example.com", "localhost"],
      trustProxyHops: 1,
      maxJsonBodyBytes: 2048,
      rateLimitPerMinute: 60,
      qurlApiUrl: "https://api.example.com/v1",
    });
  });

  it("rejects plaintext non-loopback qURL API URLs", () => {
    expect(() => loadHttpServerConfig({ QURL_API_URL: "http://api.example.com" })).toThrow(
      "must use HTTPS",
    );
    expect(loadHttpServerConfig({ QURL_API_URL: "http://127.0.0.1:8080" }).qurlApiUrl).toBe(
      "http://127.0.0.1:8080",
    );
  });

  it("rejects Host allowlist entries with ports or URL syntax", () => {
    expect(() =>
      loadHttpServerConfig({ MCP_HOST: "0.0.0.0", MCP_ALLOWED_HOSTS: "mcp.example.com:443" }),
    ).toThrow("without ports or URL schemes");
    expect(() =>
      loadHttpServerConfig({ MCP_HOST: "0.0.0.0", MCP_ALLOWED_HOSTS: "https://mcp.example.com" }),
    ).toThrow("without ports or URL schemes");
  });
});
