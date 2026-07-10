import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { rateLimit } from "express-rate-limit";
import { statSync } from "node:fs";
import { createServer as createNodeServer, request, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { markRequestCredentialValidated } from "../auth/request-context.js";
import { QURLAPIError } from "../client.js";
import { createHttpRuntime } from "../http.js";
import type { HttpServerConfig } from "../http-config.js";
import { makeMockClient, sampleCreateQURLData } from "./helpers.js";

const testConfig: HttpServerConfig = {
  port: 3000,
  host: "127.0.0.1",
  baseUrl: "http://127.0.0.1:3000",
  trustProxyHops: 0,
  maxSessions: 100,
  maxUnvalidatedSessions: 20,
  sessionIdleTtlMs: 15 * 60 * 1000,
  unvalidatedSessionTtlMs: 60 * 1000,
  mcpRateLimitPerMinute: 10_000,
  publicFileRateLimitPerMinute: 10_000,
  maxUploadFileDataBytes: 10 * 1024 * 1024,
  defaultQurlApiUrl: "https://api.layerv.ai",
};
const runtime = createHttpRuntime(testConfig, { version: "0.0.0-test" });
const { app, closeAllSessions, getActiveSessionCount, streamPublicVideo, sweepExpiredSessions } =
  runtime;

const servers: Server[] = [];
const bearerHeaders = (token: string) => ({
  authorization: `Bearer ${token}`,
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
});
const initializeBody = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "http-test", version: "1.0" },
  },
};

async function start(serverApp = app): Promise<string> {
  const server = createNodeServer(serverApp);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP test server");
  return `http://127.0.0.1:${address.port}`;
}

async function initialize(baseUrl: string, token: string): Promise<string> {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: bearerHeaders(token),
    body: JSON.stringify(initializeBody),
  });
  expect(response.status).toBe(200);
  const sessionId = response.headers.get("mcp-session-id");
  if (!sessionId) throw new Error("Expected MCP session id");
  return sessionId;
}

async function requestWithHost(url: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers: { host } }, (res) => {
      res.resume();
      res.once("end", () => resolve(res.statusCode ?? 0));
    });
    req.once("error", reject);
    req.end();
  });
}

afterEach(async () => {
  await closeAllSessions();
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

describe("HTTP MCP server", () => {
  it("creates isolated apps and session registries from explicit config", () => {
    const otherRuntime = createHttpRuntime(
      { ...testConfig, baseUrl: "http://127.0.0.1:3001" },
      { version: "0.0.0-test" },
    );

    expect(otherRuntime.app).not.toBe(app);
    expect(otherRuntime.getActiveSessionCount()).toBe(0);
    expect(getActiveSessionCount()).toBe(0);
  });

  it("serves a protected health endpoint surface without Express metadata", async () => {
    const baseUrl = await start();
    const response = await fetch(`${baseUrl}/healthz`);

    expect(response.status).toBe(200);
    expect(response.headers.get("x-powered-by")).toBeNull();
    expect(await response.json()).toEqual({ ok: true });
  });

  it("authenticates before attempting to parse JSON", async () => {
    const baseUrl = await start();
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("returns a bounded JSON-RPC error for malformed authenticated JSON", async () => {
    const baseUrl = await start();
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: bearerHeaders("lv_live_json_test"),
      body: "{not-json",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({ message: "Request body must be valid JSON." }),
      }),
    );
  });

  it("returns 413 before session handling for an oversized valid JSON body", async () => {
    const limitedRuntime = createHttpRuntime(
      { ...testConfig, maxUploadFileDataBytes: 1 },
      { version: "0.0.0-test" },
    );
    const baseUrl = await start(limitedRuntime.app);
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: bearerHeaders("lv_live_oversized_json"),
      body: JSON.stringify({ payload: "x".repeat(70_000) }),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({ message: "Request body is too large." }),
      }),
    );
  });

  it("initializes from a single-message JSON-RPC batch", async () => {
    const baseUrl = await start();
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: bearerHeaders("lv_live_batch_init"),
      body: JSON.stringify([initializeBody]),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBeTruthy();
    expect(getActiveSessionCount()).toBe(1);
  });

  it("rejects a mixed initialization batch without retaining a session", async () => {
    const baseUrl = await start();
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: bearerHeaders("lv_live_mixed_batch_init"),
      body: JSON.stringify([
        initializeBody,
        { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
      ]),
    });

    expect(response.status).toBe(400);
    expect(response.headers.get("mcp-session-id")).toBeNull();
    expect(getActiveSessionCount()).toBe(0);
  });

  it("rate-limits MCP requests before authentication", async () => {
    const limitedRuntime = createHttpRuntime(
      { ...testConfig, mcpRateLimitPerMinute: 1 },
      { version: "0.0.0-test" },
    );
    const baseUrl = await start(limitedRuntime.app);

    const first = await fetch(`${baseUrl}/mcp`, { method: "POST" });
    const second = await fetch(`${baseUrl}/mcp`, { method: "POST" });

    expect(first.status).toBe(401);
    expect(second.status).toBe(429);
  });

  it("uses the configured trusted-proxy hop when keying client rate limits", async () => {
    const proxiedRuntime = createHttpRuntime(
      { ...testConfig, trustProxyHops: 1, mcpRateLimitPerMinute: 1 },
      { version: "0.0.0-test" },
    );
    const baseUrl = await start(proxiedRuntime.app);
    const postFrom = (forwardedFor: string) =>
      fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { "x-forwarded-for": forwardedFor },
      });

    const first = await postFrom("198.51.100.1, 203.0.113.10");
    const sameTrustedPosition = await postFrom("198.51.100.2, 203.0.113.10");
    const differentTrustedPosition = await postFrom("198.51.100.2, 203.0.113.11");

    expect(first.status).toBe(401);
    expect(sameTrustedPosition.status).toBe(429);
    expect(differentTrustedPosition.status).toBe(401);
  });

  it("rate-limits the runtime-wired public video file route", async () => {
    const fixturePath = fileURLToPath(new URL("./fixtures/sample.pdf", import.meta.url));
    const videoRuntime = createHttpRuntime(
      {
        ...testConfig,
        publicFileRateLimitPerMinute: 1,
        publicVideo: {
          title: "Rate Limit Test",
          pagePath: "/media/video",
          filePath: fixturePath,
        },
      },
      { version: "0.0.0-test" },
    );
    const baseUrl = await start(videoRuntime.app);

    const first = await fetch(`${baseUrl}/media/video/file`);
    await first.arrayBuffer();
    const second = await fetch(`${baseUrl}/media/video/file`);

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
  });

  it("binds sessions to the bearer token that initialized them", async () => {
    const baseUrl = await start();
    const sessionId = await initialize(baseUrl, "lv_live_owner");

    const rejected = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { ...bearerHeaders("lv_live_other"), "mcp-session-id": sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    expect(rejected.status).toBe(404);

    const initialized = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { ...bearerHeaders("lv_live_owner"), "mcp-session-id": sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
    });
    expect(initialized.status).toBe(202);

    const listed = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { ...bearerHeaders("lv_live_owner"), "mcp-session-id": sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }),
    });
    expect(listed.status).toBe(200);
    expect(await listed.text()).toContain('"name":"create_qurl"');
  });

  it("rejects an unknown session id without creating state", async () => {
    const baseUrl = await start();
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        ...bearerHeaders("lv_live_forged_session"),
        "mcp-session-id": "00000000-0000-4000-8000-000000000000",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });

    expect(response.status).toBe(404);
    expect(getActiveSessionCount()).toBe(0);
  });

  it("evicts abandoned sessions after the configured idle window", async () => {
    const baseUrl = await start();
    const sessionId = await initialize(baseUrl, "lv_live_idle");
    expect(getActiveSessionCount()).toBe(1);

    expect(await sweepExpiredSessions(Date.now() + 24 * 60 * 60 * 1000)).toBe(1);
    expect(getActiveSessionCount()).toBe(0);

    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { ...bearerHeaders("lv_live_idle"), "mcp-session-id": sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    expect(response.status).toBe(404);
  });

  it("expires an unvalidated session even while its SSE request is active", async () => {
    const baseUrl = await start();
    const token = "lv_live_pending_sse";
    const sessionId = await initialize(baseUrl, token);

    const initialized = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { ...bearerHeaders(token), "mcp-session-id": sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
    });
    expect(initialized.status).toBe(202);

    const controller = new globalThis.AbortController();
    const sse = await fetch(`${baseUrl}/mcp`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "text/event-stream",
        "mcp-session-id": sessionId,
      },
      signal: controller.signal,
    });
    expect(sse.status).toBe(200);

    expect(await sweepExpiredSessions(Date.now() + 24 * 60 * 60 * 1000)).toBe(1);
    expect(getActiveSessionCount()).toBe(0);
    controller.abort();
  });

  it("never exceeds the configured session cap during concurrent initialization", async () => {
    const cappedRuntime = createHttpRuntime(
      { ...testConfig, maxSessions: 1, maxUnvalidatedSessions: 2 },
      { version: "0.0.0-test" },
    );
    const baseUrl = await start(cappedRuntime.app);

    try {
      const responses = await Promise.all(
        ["lv_live_race_a", "lv_live_race_b"].map((token) =>
          fetch(`${baseUrl}/mcp`, {
            method: "POST",
            headers: bearerHeaders(token),
            body: JSON.stringify(initializeBody),
          }),
        ),
      );

      expect(responses.map((response) => response.status).sort()).toEqual([200, 503]);
      expect(cappedRuntime.getActiveSessionCount()).toBe(1);
    } finally {
      await cappedRuntime.closeAllSessions();
    }
  });

  it("enforces the unvalidated-session cap independently", async () => {
    const cappedRuntime = createHttpRuntime(
      { ...testConfig, maxSessions: 2, maxUnvalidatedSessions: 1 },
      { version: "0.0.0-test" },
    );
    const baseUrl = await start(cappedRuntime.app);

    try {
      const first = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: bearerHeaders("lv_live_pending_a"),
        body: JSON.stringify(initializeBody),
      });
      const second = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: bearerHeaders("lv_live_pending_b"),
        body: JSON.stringify(initializeBody),
      });

      expect(first.status).toBe(200);
      expect(second.status).toBe(503);
      expect(cappedRuntime.getActiveSessionCount()).toBe(1);
    } finally {
      await cappedRuntime.closeAllSessions();
    }
  });

  it("promotes a session only after a successful downstream qURL call", async () => {
    const validatedRuntime = createHttpRuntime(testConfig, {
      version: "0.0.0-test",
      clientFactory: () =>
        makeMockClient({
          createQURL: vi.fn(async () => {
            markRequestCredentialValidated();
            return { data: sampleCreateQURLData() };
          }),
        }),
    });
    const baseUrl = await start(validatedRuntime.app);
    const token = "lv_live_validated";

    try {
      const sessionId = await initialize(baseUrl, token);
      await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { ...bearerHeaders(token), "mcp-session-id": sessionId },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
          params: {},
        }),
      });
      const created = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { ...bearerHeaders(token), "mcp-session-id": sessionId },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "create_qurl",
            arguments: { target_url: "https://example.com" },
          },
        }),
      });

      expect(created.status).toBe(200);
      expect(
        await validatedRuntime.sweepExpiredSessions(
          Date.now() + testConfig.unvalidatedSessionTtlMs + 1,
        ),
      ).toBe(0);
      expect(validatedRuntime.getActiveSessionCount()).toBe(1);
    } finally {
      await validatedRuntime.closeAllSessions();
    }
  });

  it("keeps a session unvalidated after a downstream authentication failure", async () => {
    const rejectedRuntime = createHttpRuntime(testConfig, {
      version: "0.0.0-test",
      clientFactory: () =>
        makeMockClient({
          createQURL: vi
            .fn()
            .mockRejectedValue(new QURLAPIError(401, "invalid_api_key", "Invalid API key.")),
        }),
    });
    const baseUrl = await start(rejectedRuntime.app);
    const token = "lv_live_rejected";

    try {
      const sessionId = await initialize(baseUrl, token);
      await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { ...bearerHeaders(token), "mcp-session-id": sessionId },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
          params: {},
        }),
      });
      const created = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { ...bearerHeaders(token), "mcp-session-id": sessionId },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "create_qurl", arguments: { target_url: "https://example.com" } },
        }),
      });

      expect(created.status).toBe(200);
      expect(await created.text()).toContain("Invalid API key");
      expect(
        await rejectedRuntime.sweepExpiredSessions(
          Date.now() + testConfig.unvalidatedSessionTtlMs + 1,
        ),
      ).toBe(1);
      expect(rejectedRuntime.getActiveSessionCount()).toBe(0);
    } finally {
      await rejectedRuntime.closeAllSessions();
    }
  });

  it("removes sessions on explicit DELETE", async () => {
    const baseUrl = await start();
    const sessionId = await initialize(baseUrl, "lv_live_delete");
    const close = vi.spyOn(McpServer.prototype, "close");

    try {
      const response = await fetch(`${baseUrl}/mcp`, {
        method: "DELETE",
        headers: {
          authorization: "Bearer lv_live_delete",
          accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId,
        },
      });
      expect(response.status).toBe(200);
      expect(getActiveSessionCount()).toBe(0);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      close.mockRestore();
    }
  });

  it("rejects Host headers outside the loopback allowlist", async () => {
    const baseUrl = await start();
    expect(await requestWithHost(`${baseUrl}/healthz`, "attacker.example")).toBe(403);
    expect((await fetch(`${baseUrl}/healthz`)).status).toBe(200);
  });

  it("enforces the configured Host allowlist for non-loopback deployments", async () => {
    const allowlistedRuntime = createHttpRuntime(
      {
        ...testConfig,
        host: "0.0.0.0",
        baseUrl: "https://mcp.example.com",
        allowedHosts: ["mcp.example.com"],
      },
      { version: "0.0.0-test" },
    );
    const baseUrl = await start(allowlistedRuntime.app);

    expect(await requestWithHost(`${baseUrl}/healthz`, "mcp.example.com")).toBe(200);
    expect(await requestWithHost(`${baseUrl}/healthz`, "mcp.example.com:8443")).toBe(200);
    expect(await requestWithHost(`${baseUrl}/healthz`, "attacker.example")).toBe(403);
  });

  it("adds defensive headers to public legal pages", async () => {
    const baseUrl = await start();
    const response = await fetch(`${baseUrl}/legal/privacy`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });
});

describe("public video range streaming", () => {
  const fixturePath = fileURLToPath(new URL("./fixtures/sample.pdf", import.meta.url));
  const fixtureSize = statSync(fixturePath).size;

  async function startVideoServer(): Promise<string> {
    const videoApp = express();
    videoApp.get("/file", rateLimit({ windowMs: 60_000, limit: 100 }), (req, res) =>
      streamPublicVideo(req, res, fixturePath),
    );
    return start(videoApp);
  }

  it("serves explicit and suffix byte ranges", async () => {
    const baseUrl = await startVideoServer();
    const explicit = await fetch(`${baseUrl}/file`, { headers: { range: "bytes=0-3" } });
    expect(explicit.status).toBe(206);
    expect(explicit.headers.get("content-range")).toBe(`bytes 0-3/${fixtureSize}`);
    expect((await explicit.arrayBuffer()).byteLength).toBe(4);

    const suffix = await fetch(`${baseUrl}/file`, { headers: { range: "bytes=-5" } });
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get("content-range")).toBe(
      `bytes ${fixtureSize - 5}-${fixtureSize - 1}/${fixtureSize}`,
    );
    expect((await suffix.arrayBuffer()).byteLength).toBe(5);
  });

  it("rejects malformed and unsatisfiable ranges", async () => {
    const baseUrl = await startVideoServer();
    for (const range of [
      "bytes=5-2",
      `bytes=${fixtureSize}-`,
      "bytes=-",
      "bytes=0-1,2-3",
      "items=0-1",
    ]) {
      const response = await fetch(`${baseUrl}/file`, { headers: { range } });
      expect(response.status).toBe(416);
      expect(response.headers.get("content-range")).toBe(`bytes */${fixtureSize}`);
    }
  });
});
