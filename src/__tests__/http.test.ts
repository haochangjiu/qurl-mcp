import express from "express";
import { rateLimit } from "express-rate-limit";
import { statSync } from "node:fs";
import { createServer as createNodeServer, request, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  app,
  closeAllSessions,
  getActiveSessionCount,
  streamPublicVideo,
  sweepExpiredSessions,
} from "../http.js";

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

  it("binds sessions to the bearer token that initialized them", async () => {
    const baseUrl = await start();
    const sessionId = await initialize(baseUrl, "lv_live_owner");

    const rejected = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { ...bearerHeaders("lv_live_other"), "mcp-session-id": sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    expect(rejected.status).toBe(403);

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

  it("removes sessions on explicit DELETE", async () => {
    const baseUrl = await start();
    const sessionId = await initialize(baseUrl, "lv_live_delete");

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
  });

  it("rejects Host headers outside the loopback allowlist", async () => {
    const baseUrl = await start();
    expect(await requestWithHost(`${baseUrl}/healthz`, "attacker.example")).toBe(403);
    expect((await fetch(`${baseUrl}/healthz`)).status).toBe(200);
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
    for (const range of ["bytes=5-2", `bytes=${fixtureSize}-`, "bytes=-", "items=0-1"]) {
      const response = await fetch(`${baseUrl}/file`, { headers: { range } });
      expect(response.status).toBe(416);
      expect(response.headers.get("content-range")).toBe(`bytes */${fixtureSize}`);
    }
  });
});
