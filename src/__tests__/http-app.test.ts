import { createServer as createNodeServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpApp, type HttpAppConfig } from "../http-app.js";

const servers: Server[] = [];

const initializeBody = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0" },
  },
};

function makeConfig(overrides: Partial<HttpAppConfig> = {}): HttpAppConfig {
  return {
    version: "0.0.0-test",
    port: 3000,
    host: "127.0.0.1",
    trustProxyHops: 0,
    maxJsonBodyBytes: 1024 * 1024,
    rateLimitPerMinute: 120,
    qurlApiUrl: "https://api.layerv.ai",
    ...overrides,
  };
}

async function startApp(config = makeConfig()): Promise<string> {
  const server = createNodeServer(createHttpApp(config));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP test server");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
});

describe("HTTP MCP app", () => {
  it("exposes a public health check without exposing Express metadata", async () => {
    const baseUrl = await startApp();
    const response = await fetch(`${baseUrl}/healthz`);

    expect(response.status).toBe(200);
    expect(response.headers.get("x-powered-by")).toBeNull();
    expect(await response.json()).toEqual({ ok: true });
  });

  it("requires bearer authentication before parsing MCP requests", async () => {
    const baseUrl = await startApp(makeConfig({ maxJsonBodyBytes: 1024 }));
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(2048),
    });

    expect(response.status).toBe(401);
  });

  it("serves stateless Streamable HTTP initialization", async () => {
    const baseUrl = await startApp();
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: "Bearer lv_live_test",
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify(initializeBody),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBeNull();
    const body = await response.text();
    expect(body).toContain('"name":"qurl"');
    expect(body).toContain('"version":"0.0.0-test"');
  });

  it("serves tool discovery on an independent stateless request", async () => {
    const baseUrl = await startApp();
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: "Bearer lv_live_test",
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('"name":"create_qurl"');
    expect(body).toContain('"name":"mint_link"');
  });

  it("rejects unsupported session methods", async () => {
    const baseUrl = await startApp();
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "DELETE",
      headers: { authorization: "Bearer lv_live_test" },
    });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("rejects oversized authenticated JSON bodies", async () => {
    const baseUrl = await startApp(makeConfig({ maxJsonBodyBytes: 1024 }));
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: "Bearer lv_live_test",
        "content-type": "application/json",
      },
      body: JSON.stringify({ payload: "x".repeat(2048) }),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({ message: "Request body is too large." }),
      }),
    );
  });

  it("returns a JSON-RPC error for malformed authenticated JSON", async () => {
    const baseUrl = await startApp();
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: "Bearer lv_live_test",
        "content-type": "application/json",
      },
      body: "{not-json",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({ message: "Request body must be valid JSON." }),
      }),
    );
  });

  it("enforces the configured Host allowlist", async () => {
    const baseUrl = await startApp(
      makeConfig({ host: "0.0.0.0", allowedHosts: ["mcp.example.com"] }),
    );

    const rejected = await fetch(`${baseUrl}/healthz`);
    expect(rejected.status).toBe(403);

    const acceptedBaseUrl = await startApp(
      makeConfig({ host: "0.0.0.0", allowedHosts: ["127.0.0.1"] }),
    );
    const accepted = await fetch(`${acceptedBaseUrl}/healthz`);
    expect(accepted.status).toBe(200);
  });

  it("rate limits authenticated requests before parsing their bodies", async () => {
    const baseUrl = await startApp(makeConfig({ rateLimitPerMinute: 1 }));
    const request = () =>
      fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          authorization: "Bearer lv_live_test",
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify(initializeBody),
      });

    expect((await request()).status).toBe(200);
    const limited = await request();
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({ message: "Too many requests." }),
      }),
    );
  });
});
