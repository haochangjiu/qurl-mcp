#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { installTimestampedConsole } from "./logging.js";
import express from "express";
import {
  hostHeaderValidation,
  localhostHostValidation,
} from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { runWithRequestAuthContext } from "./auth/request-context.js";
import { getDefaultConfigPath, inspectSmtpConfig } from "./config.js";
import { getDefaultHttpConfigPath, loadHttpServerConfig } from "./http-config.js";
import { MISSING_API_KEY_MESSAGE, QURLClient } from "./client.js";
import { getLegalDocuments, renderLegalDocumentHtml } from "./services/legal-pages.js";
import {
  getPublicVideoFileRoute,
  renderPublicVideoPageHtml,
} from "./services/video-page.js";
import { createServer } from "./server.js";

installTimestampedConsole();

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

type SessionContext = {
  transport: StreamableHTTPServerTransport;
  server: ReturnType<typeof createServer>;
};

const configPath = getDefaultHttpConfigPath();
const runtimeConfigPath = getDefaultConfigPath();
const config = loadHttpServerConfig(configPath);
const port = config.port;
const host = config.host;
const baseUrl = config.baseUrl;
const defaultQurlApiUrl = config.defaultQurlApiUrl;
const defaultQurlConnectorUrl = config.defaultQurlConnectorUrl;
const configuredQurlApiKey = config.qurlApiKey ?? "";
const httpClient = new QURLClient({
  apiKey: configuredQurlApiKey,
  baseURL: defaultQurlApiUrl,
});

function getJsonBodyLimitBytes(maxUploadFileDataBytes: number): number {
  // Base64 inflates payload size by roughly 4/3; keep extra headroom for JSON envelope fields.
  return Math.ceil(maxUploadFileDataBytes * 1.5) + 64 * 1024;
}

const app = express();
app.use(express.json({ limit: getJsonBodyLimitBytes(config.maxUploadFileDataBytes) }));

if (config.allowedHosts?.length) {
  app.use(hostHeaderValidation(config.allowedHosts));
} else {
  const localhostHosts = ["127.0.0.1", "localhost", "::1"];
  if (localhostHosts.includes(host)) {
    app.use(localhostHostValidation());
  } else if (host === "0.0.0.0" || host === "::") {
    console.warn(
      `Warning: Server is binding to ${host} without DNS rebinding protection. ` +
        "Consider setting allowedHosts to restrict accepted Host headers.",
    );
  }
}

const sessions = new Map<string, SessionContext>();

function getSessionId(req: IncomingMessage): string | undefined {
  const header = req.headers["mcp-session-id"];
  return typeof header === "string" ? header : undefined;
}

function formatDurationMs(startedAt: number): string {
  return `${Date.now() - startedAt}ms`;
}

function getJsonRpcMethod(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  return "method" in body && typeof body.method === "string" ? body.method : undefined;
}

function getToolNameFromBody(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  if (!("params" in body) || typeof body.params !== "object" || body.params === null) return undefined;
  return "name" in body.params && typeof body.params.name === "string" ? body.params.name : undefined;
}

function logRequestSummary(req: IncomingMessage, route: string, body?: unknown): void {
  const method = req.method ?? "UNKNOWN";
  const sessionId = getSessionId(req) ?? "(none)";
  const rpcMethod = getJsonRpcMethod(body);
  const toolName = rpcMethod === "tools/call" ? getToolNameFromBody(body) : undefined;
  const toolSuffix = toolName ? ` tool=${toolName}` : "";
  const rpcSuffix = rpcMethod ? ` rpc=${rpcMethod}` : "";
  console.warn(`[mcp-http session=${sessionId}] ${method} ${route}${rpcSuffix}${toolSuffix}`);
}

function formatBodyForLog(body: unknown): string {
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

function rejectJsonRpc(res: ServerResponse, statusCode: number, message: string): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message,
      },
      id: null,
    }),
  );
}

function streamPublicVideo(req: express.Request, res: express.Response, filePath: string): void {
  if (!existsSync(filePath)) {
    res.status(404).send("Configured video file was not found.");
    return;
  }

  const stats = statSync(filePath);
  const fileSize = stats.size;
  const range = req.headers.range;

  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Cache-Control", "public, max-age=300");

  if (!range) {
    res.setHeader("Content-Length", fileSize);
    createReadStream(filePath).pipe(res);
    return;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    res.status(416).setHeader("Content-Range", `bytes */${fileSize}`).end();
    return;
  }

  const parsedStart = match[1] ? Number(match[1]) : undefined;
  const parsedEnd = match[2] ? Number(match[2]) : undefined;

  let start = parsedStart ?? 0;
  let end = parsedEnd ?? fileSize - 1;

  if (parsedStart === undefined && parsedEnd !== undefined) {
    start = Math.max(fileSize - parsedEnd, 0);
    end = fileSize - 1;
  }

  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < 0 ||
    start >= fileSize ||
    end >= fileSize ||
    start > end
  ) {
    res.status(416).setHeader("Content-Range", `bytes */${fileSize}`).end();
    return;
  }

  const chunkSize = end - start + 1;
  res.status(206);
  res.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
  res.setHeader("Content-Length", chunkSize);
  createReadStream(filePath, { start, end }).pipe(res);
}

const REINITIALIZE_MESSAGE =
  "Session not found. The MCP server may have restarted. Please re-initialize the MCP connection.";

function logMissingSession(
  req: IncomingMessage,
  body?: unknown,
): void {
  const sessionId = getSessionId(req) ?? "(none)";
  const method = req.method ?? "UNKNOWN";
  const rpcMethod = getJsonRpcMethod(body);
  const toolName = rpcMethod === "tools/call" ? getToolNameFromBody(body) : undefined;
  const action =
    method === "GET"
      ? "sse stream open/reconnect"
      : method === "DELETE"
        ? "session close request"
        : rpcMethod === "notifications/initialized"
          ? "client initialization completed notification"
          : rpcMethod === "initialize"
            ? "session initialization request"
            : rpcMethod === "tools/call"
              ? "tool call request"
              : "request";
  const rpcSuffix = rpcMethod ? ` rpc=${rpcMethod}` : "";
  const toolSuffix = toolName ? ` tool=${toolName}` : "";
  console.warn(
    `[mcp-http session=${sessionId}] session missing; client must re-initialize action="${action}" method=${method}${rpcSuffix}${toolSuffix}`,
  );
}

function withRequestAuth<T>(sessionId: string | undefined, fn: () => Promise<T>) {
  return runWithRequestAuthContext(
    {
      sessionId: sessionId ?? "(none)",
      qurlApiKey: configuredQurlApiKey || undefined,
      qurlConnectorUrl: defaultQurlConnectorUrl,
      maxUploadFileDataBytes: config.maxUploadFileDataBytes,
    },
    fn,
  );
}

app.post("/mcp", async (req, res) => {
  logRequestSummary(req, "/mcp", req.body);
  const sessionId = getSessionId(req);
  const startedAt = Date.now();
  const rpcMethod = getJsonRpcMethod(req.body);
  const toolName = rpcMethod === "tools/call" ? getToolNameFromBody(req.body) : undefined;

  try {
    if (!sessionId) {
      if (!isInitializeRequest(req.body)) {
        console.warn("[mcp-http] rejected POST /mcp: first request was not initialize");
        console.warn(`[mcp-http] received body: ${formatBodyForLog(req.body)}`);
        rejectJsonRpc(res, 400, "Initialization request required.");
        return;
      }

      const server = createServer(httpClient, version, "http");
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      transport.onclose = () => {
        // Some clients/proxies reconnect the GET SSE stream with the same
        // session ID. Deleting the in-memory session record here can cause
        // a subsequent GET /mcp to be rejected as "unknown session" even
        // though the client is attempting a valid reconnect. Explicit DELETE
        // requests still remove sessions from the registry.
      };

      await server.connect(transport);
      await withRequestAuth(undefined, () => transport.handleRequest(req, res, req.body));

      if (!transport.sessionId) {
        console.warn("[mcp-http] initialize completed without session id");
        await server.close();
        return;
      }

      sessions.set(transport.sessionId, {
        transport,
        server,
      });
      console.warn(
        `[mcp-http session=${transport.sessionId}] initialize completed elapsed=${formatDurationMs(startedAt)}`,
      );
      return;
    }

    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session) {
      logMissingSession(req, req.body);
      rejectJsonRpc(res, 404, REINITIALIZE_MESSAGE);
      return;
    }

    if (toolName) {
      console.warn(`[mcp-http session=${sessionId}] tool call started name=${toolName}`);
    }
    await withRequestAuth(sessionId, () => session.transport.handleRequest(req, res, req.body));
    if (toolName) {
      console.warn(
        `[mcp-http session=${sessionId}] tool call finished name=${toolName} elapsed=${formatDurationMs(startedAt)}`,
      );
    }
  } catch (error) {
    if (toolName) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[mcp-http session=${sessionId ?? "(none)"}] tool call failed name=${toolName} elapsed=${formatDurationMs(startedAt)} error=${message}`,
      );
    }
    console.error("Error handling MCP POST request", error);
    if (!res.headersSent) {
      rejectJsonRpc(res, 500, "Internal server error.");
    }
  }
});

app.get("/mcp", async (req, res) => {
  const sessionId = getSessionId(req);
  const session = sessionId ? sessions.get(sessionId) : undefined;
  if (!session) {
    logMissingSession(req);
    res.status(404).send(REINITIALIZE_MESSAGE);
    return;
  }

  try {
    await withRequestAuth(sessionId, () => session.transport.handleRequest(req, res));
  } catch (error) {
    console.error("Error handling MCP GET request", error);
    if (!res.headersSent) {
      res.status(500).send("Internal server error.");
    }
  }
});

app.delete("/mcp", async (req, res) => {
  const sessionId = getSessionId(req);
  const session = sessionId ? sessions.get(sessionId) : undefined;
  if (!session || !sessionId) {
    logMissingSession(req);
    res.status(404).send(REINITIALIZE_MESSAGE);
    return;
  }

  try {
    console.warn(`[mcp-http session=${sessionId}] closing`);
    await withRequestAuth(sessionId, () => session.transport.handleRequest(req, res));
  } catch (error) {
    console.error("Error handling MCP DELETE request", error);
    if (!res.headersSent) {
      res.status(500).send("Internal server error.");
    }
  } finally {
    // `transport.handleRequest()` for DELETE already closes the underlying
    // transport/session in the SDK. Closing the server again here can recurse
    // back into the same transport close path.
    sessions.delete(sessionId);
  }
});

for (const document of getLegalDocuments()) {
  app.get(document.path, (_req, res) => {
    const html = renderLegalDocumentHtml(document.path, baseUrl);
    if (!html) {
      res.status(404).send("Not found");
      return;
    }
    res.type("html").send(html);
  });
}

if (config.publicVideo) {
  const videoPagePath = config.publicVideo.pagePath;
  const videoFileRoute = getPublicVideoFileRoute(videoPagePath);

  app.get(videoPagePath, (_req, res) => {
    const html = renderPublicVideoPageHtml(config.publicVideo!, baseUrl);
    res.type("html").send(html);
  });

  app.get(videoFileRoute, (req, res) => {
    streamPublicVideo(req, res, config.publicVideo!.filePath);
  });
}

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

app.listen(port, host, () => {
  console.warn(`qURL MCP HTTP server listening on ${host}:${port}`);
  console.warn("HTTP MCP auth mode: No Auth");
  console.warn(`HTTP config loaded from ${configPath}`);
  console.warn(`Runtime config loaded from ${runtimeConfigPath}`);
  console.warn(`Configured baseUrl: ${config.baseUrl}`);
  for (const document of getLegalDocuments()) {
    console.warn(`Public legal page available at ${config.baseUrl}${document.path}`);
  }
  if (config.publicVideo) {
    console.warn(`Public video page available at ${config.baseUrl}${config.publicVideo.pagePath}`);
  }
  console.warn(`Configured qURL API URL: ${defaultQurlApiUrl}`);
  if (!configuredQurlApiKey) {
    console.warn(`Warning: ${MISSING_API_KEY_MESSAGE}`);
  }
  if (defaultQurlConnectorUrl) {
    console.warn(`Configured qURL Connector URL: ${defaultQurlConnectorUrl}`);
  }
  const smtpInspection = inspectSmtpConfig(runtimeConfigPath);
  if (smtpInspection.enabled) {
    console.warn(
      `SMTP is configured. host=${smtpInspection.host} port=${smtpInspection.port} secure=${smtpInspection.secure} user=${smtpInspection.username ?? "(missing)"} from=${smtpInspection.fromEmail ?? "(missing)"}`,
    );
  } else {
    console.warn(
      `SMTP is not configured. Missing fields: ${smtpInspection.missingFields.join(", ") || "(unknown)"}`,
    );
  }
  if (config.allowedHosts?.length) {
    console.warn(`Allowed hosts: ${config.allowedHosts.join(", ")}`);
  }
});
