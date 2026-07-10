#!/usr/bin/env node

import { randomUUID, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
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
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { rateLimit } from "express-rate-limit";
import { runWithRequestAuthContext } from "./auth/request-context.js";
import {
  createPassthroughBearerVerifier,
  createQurlClientFromBearerToken,
} from "./auth/static-bearer.js";
import { getDefaultConfigPath, inspectSmtpConfig } from "./config.js";
import { getDefaultHttpConfigPath, loadHttpServerConfig } from "./http-config.js";
import { getLegalDocuments, renderLegalDocumentHtml } from "./services/legal-pages.js";
import { getPublicVideoFileRoute, renderPublicVideoPageHtml } from "./services/video-page.js";
import { createServer } from "./server.js";

installTimestampedConsole();

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

type SessionContext = {
  sessionId: string;
  transport: StreamableHTTPServerTransport;
  server: ReturnType<typeof createServer>;
  bearerToken: string;
};

const configPath = getDefaultHttpConfigPath();
const runtimeConfigPath = getDefaultConfigPath();
const config = loadHttpServerConfig(configPath);
const port = config.port;
const host = config.host;
const baseUrl = config.baseUrl;
const defaultQurlApiUrl = config.defaultQurlApiUrl;
const defaultQurlConnectorUrl = config.defaultQurlConnectorUrl;

function getJsonBodyLimitBytes(maxUploadFileDataBytes: number): number {
  // Base64 inflates payload size by roughly 4/3; keep extra headroom for JSON envelope fields.
  return Math.ceil(maxUploadFileDataBytes * 1.5) + 64 * 1024;
}

const app = express();
app.use(express.json({ limit: getJsonBodyLimitBytes(config.maxUploadFileDataBytes) }));

const mcpRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});
const publicFileRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 300,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});
const bearerAuthMiddleware = requireBearerAuth({
  verifier: createPassthroughBearerVerifier({ qurlApiUrl: defaultQurlApiUrl }),
  requiredScopes: ["mcp:tools"],
});

if (config.allowedHosts?.length) {
  app.use(hostHeaderValidation(config.allowedHosts));
} else {
  const localhostHosts = ["127.0.0.1", "localhost", "::1"];
  if (localhostHosts.includes(host)) {
    app.use(localhostHostValidation());
  } else if (host === "0.0.0.0" || host === "::") {
    console.warn(
      `Warning: Server is binding to ${sanitizeLogValue(host)} without DNS rebinding protection. ` +
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

function sanitizeLogValue(value: string): string {
  return value.replace(/[\r\n\u2028\u2029]/g, " ").slice(0, 512);
}

function getAuthenticatedBearerToken(req: express.Request): string | undefined {
  const token = req.auth?.token.trim();
  return token ? token : undefined;
}

function bearerTokensMatch(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function getJsonRpcMethod(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  return "method" in body && typeof body.method === "string" ? body.method : undefined;
}

function getToolNameFromBody(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  if (!("params" in body) || typeof body.params !== "object" || body.params === null)
    return undefined;
  return "name" in body.params && typeof body.params.name === "string"
    ? body.params.name
    : undefined;
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

function logMissingSession(): void {
  console.warn("[mcp-http] session missing; client must re-initialize");
}

function withRequestAuth<T>(
  sessionId: string | undefined,
  qurlApiKey: string,
  fn: () => Promise<T>,
) {
  return runWithRequestAuthContext(
    {
      sessionId: sessionId ?? "(none)",
      qurlApiKey,
      qurlConnectorUrl: defaultQurlConnectorUrl,
      maxUploadFileDataBytes: config.maxUploadFileDataBytes,
    },
    fn,
  );
}

app.post("/mcp", mcpRateLimiter, bearerAuthMiddleware, async (req, res) => {
  const sessionId = getSessionId(req);
  const bearerToken = getAuthenticatedBearerToken(req);
  const startedAt = Date.now();
  const rpcMethod = getJsonRpcMethod(req.body);
  const toolName = rpcMethod === "tools/call" ? getToolNameFromBody(req.body) : undefined;

  if (!bearerToken) {
    rejectJsonRpc(res, 401, "Bearer authentication required.");
    return;
  }

  try {
    if (isInitializeRequest(req.body)) {
      // Initialization always creates a fresh session. Discard any supplied
      // session header before handing the request to the MCP transport so a
      // caller cannot use header presence to select a privileged code path.
      delete req.headers["mcp-session-id"];

      const server = createServer(
        createQurlClientFromBearerToken(bearerToken, { qurlApiUrl: defaultQurlApiUrl }),
        version,
        "http",
      );
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
      await withRequestAuth(undefined, bearerToken, () =>
        transport.handleRequest(req, res, req.body),
      );

      if (!transport.sessionId) {
        console.warn("[mcp-http] initialize completed without session id");
        await server.close();
        return;
      }

      sessions.set(transport.sessionId, {
        sessionId: transport.sessionId,
        transport,
        server,
        bearerToken,
      });
      console.warn(`[mcp-http] initialize completed elapsed=${formatDurationMs(startedAt)}`);
      return;
    }

    const session = sessions.get(sessionId ?? "");
    if (!session) {
      logMissingSession();
      rejectJsonRpc(res, 404, REINITIALIZE_MESSAGE);
      return;
    }
    if (!bearerTokensMatch(bearerToken, session.bearerToken)) {
      console.warn("[mcp-http] rejected request from a different bearer token");
      rejectJsonRpc(res, 403, "This session belongs to a different bearer token.");
      return;
    }

    if (toolName) {
      console.warn("[mcp-http] tool call started");
    }
    await withRequestAuth(session.sessionId, bearerToken, () =>
      session.transport.handleRequest(req, res, req.body),
    );
    if (toolName) {
      console.warn(`[mcp-http] tool call finished elapsed=${formatDurationMs(startedAt)}`);
    }
  } catch {
    if (toolName) {
      console.error(`[mcp-http] tool call failed elapsed=${formatDurationMs(startedAt)}`);
    }
    console.error("Error handling MCP POST request");
    if (!res.headersSent) {
      rejectJsonRpc(res, 500, "Internal server error.");
    }
  }
});

app.get("/mcp", mcpRateLimiter, bearerAuthMiddleware, async (req, res) => {
  const sessionId = getSessionId(req);
  const bearerToken = getAuthenticatedBearerToken(req);
  const session = sessions.get(sessionId ?? "");
  if (!session) {
    logMissingSession();
    res.status(404).send(REINITIALIZE_MESSAGE);
    return;
  }
  if (!bearerToken || !bearerTokensMatch(bearerToken, session.bearerToken)) {
    res.status(403).send("This session belongs to a different bearer token.");
    return;
  }

  try {
    await withRequestAuth(session.sessionId, bearerToken, () =>
      session.transport.handleRequest(req, res),
    );
  } catch {
    console.error("Error handling MCP GET request");
    if (!res.headersSent) {
      res.status(500).send("Internal server error.");
    }
  }
});

app.delete("/mcp", mcpRateLimiter, bearerAuthMiddleware, async (req, res) => {
  const sessionId = getSessionId(req);
  const bearerToken = getAuthenticatedBearerToken(req);
  const session = sessions.get(sessionId ?? "");
  if (!session) {
    logMissingSession();
    res.status(404).send(REINITIALIZE_MESSAGE);
    return;
  }
  if (!bearerToken || !bearerTokensMatch(bearerToken, session.bearerToken)) {
    res.status(403).send("This session belongs to a different bearer token.");
    return;
  }

  try {
    console.warn("[mcp-http] closing session");
    await withRequestAuth(session.sessionId, bearerToken, () =>
      session.transport.handleRequest(req, res),
    );
  } catch {
    console.error("Error handling MCP DELETE request");
    if (!res.headersSent) {
      res.status(500).send("Internal server error.");
    }
  } finally {
    // `transport.handleRequest()` for DELETE already closes the underlying
    // transport/session in the SDK. Closing the server again here can recurse
    // back into the same transport close path.
    sessions.delete(session.sessionId);
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

  app.get(videoFileRoute, publicFileRateLimiter, (req, res) => {
    streamPublicVideo(req, res, config.publicVideo!.filePath);
  });
}

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

app.listen(port, host, () => {
  console.warn(`qURL MCP HTTP server listening on ${sanitizeLogValue(host)}:${port}`);
  console.warn("HTTP MCP auth mode: bearer token (qURL API key passthrough)");
  console.warn("HTTP and runtime config loaded.");
  console.warn(`Public legal pages enabled: ${getLegalDocuments().length}`);
  if (config.publicVideo) {
    console.warn("Public video page enabled.");
  }
  if (defaultQurlConnectorUrl) {
    console.warn("qURL Connector uploads enabled.");
  }
  const smtpInspection = inspectSmtpConfig(runtimeConfigPath);
  if (smtpInspection.enabled) {
    console.warn("SMTP is configured.");
  } else {
    console.warn(
      `SMTP is not configured. Missing fields: ${smtpInspection.missingFields.join(", ") || "(unknown)"}`,
    );
  }
  if (config.allowedHosts?.length) {
    console.warn(`Host allowlist enabled with ${config.allowedHosts.length} entries.`);
  }
});
