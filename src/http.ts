#!/usr/bin/env node

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { clearInterval, clearTimeout, setInterval, setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";
import { installTimestampedConsole, logInfo } from "./logging.js";
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

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

type SessionContext = {
  sessionId: string;
  transport: StreamableHTTPServerTransport;
  server: ReturnType<typeof createServer>;
  bearerTokenDigest: Buffer;
  lastActivityAt: number;
  activeRequests: number;
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

export const app = express();
app.disable("x-powered-by");
if (config.trustProxyHops > 0) {
  app.set("trust proxy", config.trustProxyHops);
}

const mcpRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: config.mcpRateLimitPerMinute,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  handler: (_req, res) => rejectJsonRpc(res, 429, "Too many requests."),
});
const publicFileRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: config.publicFileRateLimitPerMinute,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).send("Too many requests.");
  },
});
const bearerAuthMiddleware = requireBearerAuth({
  verifier: createPassthroughBearerVerifier(),
  requiredScopes: ["mcp:tools"],
});

if (config.allowedHosts?.length) {
  app.use(hostHeaderValidation(config.allowedHosts));
} else {
  app.use(localhostHostValidation());
}

const parseMcpJsonBody = express.json({
  limit: getJsonBodyLimitBytes(config.maxUploadFileDataBytes),
  strict: true,
});

const sessions = new Map<string, SessionContext>();

async function closeSession(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) return;
  sessions.delete(sessionId);
  try {
    await session.server.close();
  } catch (error) {
    console.error(`[mcp-http] session close failed (${formatErrorForLog(error)})`);
  }
}

export async function sweepExpiredSessions(now = Date.now()): Promise<number> {
  const expiredIds = [...sessions.values()]
    .filter(
      (session) =>
        session.activeRequests === 0 && now - session.lastActivityAt >= config.sessionIdleTtlMs,
    )
    .map((session) => session.sessionId);
  await Promise.all(expiredIds.map((sessionId) => closeSession(sessionId)));
  return expiredIds.length;
}

export async function closeAllSessions(): Promise<void> {
  await Promise.all([...sessions.keys()].map((sessionId) => closeSession(sessionId)));
}

export function getActiveSessionCount(): number {
  return sessions.size;
}

function getSessionId(req: IncomingMessage): string | undefined {
  const header = req.headers["mcp-session-id"];
  return typeof header === "string" ? header : undefined;
}

function formatDurationMs(startedAt: number): string {
  return `${Date.now() - startedAt}ms`;
}

function sanitizeLogValue(value: string): string {
  return value
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\blv_[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/[\r\n\u2028\u2029]/g, " ")
    .slice(0, 512);
}

function formatErrorForLog(error: unknown): string {
  if (!(error instanceof Error)) return "UnknownError";
  const name = sanitizeLogValue(error.name || "Error");
  const message = sanitizeLogValue(error.message || "no message");
  return `${name}: ${message}`;
}

function getAuthenticatedBearerToken(req: express.Request): string | undefined {
  const token = req.auth?.token.trim();
  return token ? token : undefined;
}

function digestBearerToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function bearerTokenMatches(token: string, expectedDigest: Buffer): boolean {
  return timingSafeEqual(digestBearerToken(token), expectedDigest);
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

export function streamPublicVideo(
  req: express.Request,
  res: express.Response,
  filePath: string,
): void {
  let stats;
  try {
    if (!existsSync(filePath)) {
      res.status(404).send("Configured video file was not found.");
      return;
    }
    stats = statSync(filePath);
  } catch (error) {
    console.error(`[public-video] file inspection failed (${formatErrorForLog(error)})`);
    res.status(404).send("Configured video file was not found.");
    return;
  }
  if (!stats.isFile()) {
    res.status(404).send("Configured video file was not found.");
    return;
  }

  const fileSize = stats.size;
  const range = req.headers.range;

  const pipeFile = (start?: number, end?: number): void => {
    const stream = createReadStream(filePath, { start, end });
    stream.once("error", (error) => {
      console.error(`[public-video] stream failed (${formatErrorForLog(error)})`);
      res.destroy(error);
    });
    stream.pipe(res);
  };

  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (!range) {
    res.setHeader("Content-Length", fileSize);
    pipeFile();
    return;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    res.status(416).setHeader("Content-Range", `bytes */${fileSize}`).end();
    return;
  }

  const parsedStart = match[1] ? Number(match[1]) : undefined;
  const parsedEnd = match[2] ? Number(match[2]) : undefined;
  if (parsedStart === undefined && parsedEnd === undefined) {
    res.status(416).setHeader("Content-Range", `bytes */${fileSize}`).end();
    return;
  }

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
  pipeFile(start, end);
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

app.post("/mcp", mcpRateLimiter, bearerAuthMiddleware, parseMcpJsonBody, async (req, res) => {
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
      await sweepExpiredSessions();
      if (sessions.size >= config.maxSessions) {
        rejectJsonRpc(res, 503, "The MCP session limit has been reached. Try again later.");
        return;
      }

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
        // requests still remove sessions from the registry. The idle TTL
        // bounds how long a disconnected session remains available.
        const currentSessionId = transport.sessionId;
        const currentSession = currentSessionId ? sessions.get(currentSessionId) : undefined;
        if (currentSession) currentSession.lastActivityAt = Date.now();
      };

      try {
        await server.connect(transport);
        await withRequestAuth(undefined, bearerToken, () =>
          transport.handleRequest(req, res, req.body),
        );
      } catch (error) {
        await server.close().catch((closeError: unknown) => {
          console.error(`[mcp-http] initialize cleanup failed (${formatErrorForLog(closeError)})`);
        });
        throw error;
      }

      if (!transport.sessionId) {
        console.warn("[mcp-http] initialize completed without session id");
        await server.close();
        return;
      }

      sessions.set(transport.sessionId, {
        sessionId: transport.sessionId,
        transport,
        server,
        bearerTokenDigest: digestBearerToken(bearerToken),
        lastActivityAt: Date.now(),
        activeRequests: 0,
      });
      logInfo(`[mcp-http] initialize completed elapsed=${formatDurationMs(startedAt)}`);
      return;
    }

    const session = sessions.get(sessionId ?? "");
    if (!session) {
      logMissingSession();
      rejectJsonRpc(res, 404, REINITIALIZE_MESSAGE);
      return;
    }
    if (!bearerTokenMatches(bearerToken, session.bearerTokenDigest)) {
      console.warn("[mcp-http] rejected request from a different bearer token");
      rejectJsonRpc(res, 403, "This session belongs to a different bearer token.");
      return;
    }

    session.lastActivityAt = Date.now();
    if (toolName) logInfo("[mcp-http] tool call started");
    session.activeRequests += 1;
    try {
      await withRequestAuth(session.sessionId, bearerToken, () =>
        session.transport.handleRequest(req, res, req.body),
      );
    } finally {
      session.activeRequests -= 1;
      session.lastActivityAt = Date.now();
    }
    if (toolName) logInfo(`[mcp-http] tool call finished elapsed=${formatDurationMs(startedAt)}`);
  } catch (error) {
    if (toolName) {
      console.error(`[mcp-http] tool call failed elapsed=${formatDurationMs(startedAt)}`);
    }
    console.error(`Error handling MCP POST request (${formatErrorForLog(error)})`);
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
  if (!bearerToken || !bearerTokenMatches(bearerToken, session.bearerTokenDigest)) {
    res.status(403).send("This session belongs to a different bearer token.");
    return;
  }

  try {
    session.lastActivityAt = Date.now();
    session.activeRequests += 1;
    try {
      await withRequestAuth(session.sessionId, bearerToken, () =>
        session.transport.handleRequest(req, res),
      );
    } finally {
      session.activeRequests -= 1;
      session.lastActivityAt = Date.now();
    }
  } catch (error) {
    console.error(`Error handling MCP GET request (${formatErrorForLog(error)})`);
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
  if (!bearerToken || !bearerTokenMatches(bearerToken, session.bearerTokenDigest)) {
    res.status(403).send("This session belongs to a different bearer token.");
    return;
  }

  try {
    logInfo("[mcp-http] closing session");
    session.lastActivityAt = Date.now();
    session.activeRequests += 1;
    await withRequestAuth(session.sessionId, bearerToken, () =>
      session.transport.handleRequest(req, res),
    );
  } catch (error) {
    console.error(`Error handling MCP DELETE request (${formatErrorForLog(error)})`);
    if (!res.headersSent) {
      res.status(500).send("Internal server error.");
    }
  } finally {
    // `transport.handleRequest()` for DELETE already closes the underlying
    // transport/session in the SDK. Closing the server again here can recurse
    // back into the same transport close path.
    sessions.delete(session.sessionId);
    session.activeRequests = Math.max(0, session.activeRequests - 1);
  }
});

const jsonBodyErrorHandler: express.ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  const bodyError = error as { status?: number; type?: string };
  if (bodyError.status === 413 || bodyError.type === "entity.too.large") {
    rejectJsonRpc(res, 413, "Request body is too large.");
    return;
  }
  if (error instanceof SyntaxError) {
    rejectJsonRpc(res, 400, "Request body must be valid JSON.");
    return;
  }
  if (typeof bodyError.status === "number" && bodyError.status >= 400 && bodyError.status < 500) {
    rejectJsonRpc(res, bodyError.status, "Request body could not be processed.");
    return;
  }
  console.error(`HTTP middleware failed (${formatErrorForLog(error)})`);
  rejectJsonRpc(res, 500, "Internal server error.");
};

function setPublicPageSecurityHeaders(res: express.Response): void {
  res.set({
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
}

for (const document of getLegalDocuments()) {
  app.get(document.path, (_req, res) => {
    const html = renderLegalDocumentHtml(document.path, baseUrl);
    if (!html) {
      res.status(404).send("Not found");
      return;
    }
    setPublicPageSecurityHeaders(res);
    res.type("html").send(html);
  });
}

if (config.publicVideo) {
  const videoPagePath = config.publicVideo.pagePath;
  const videoFileRoute = getPublicVideoFileRoute(videoPagePath);

  app.get(videoPagePath, (_req, res) => {
    const html = renderPublicVideoPageHtml(config.publicVideo!, baseUrl);
    setPublicPageSecurityHeaders(res);
    res.type("html").send(html);
  });

  app.get(videoFileRoute, publicFileRateLimiter, (req, res) => {
    streamPublicVideo(req, res, config.publicVideo!.filePath);
  });
}

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

app.use(jsonBodyErrorHandler);

export function startHttpServer(): Server {
  installTimestampedConsole();
  let sweepInProgress = false;
  const sweepTimer = setInterval(
    () => {
      if (sweepInProgress) return;
      sweepInProgress = true;
      void sweepExpiredSessions()
        .catch((error: unknown) => {
          console.error(`[mcp-http] session sweep failed (${formatErrorForLog(error)})`);
        })
        .finally(() => {
          sweepInProgress = false;
        });
    },
    Math.min(60_000, Math.max(10_000, Math.floor(config.sessionIdleTtlMs / 2))),
  );
  sweepTimer.unref();

  const httpServer = app.listen(port, host, () => {
    logInfo(`qURL MCP HTTP server listening on ${sanitizeLogValue(host)}:${port}`);
    logInfo("HTTP MCP auth mode: bearer token (qURL API key passthrough)");
    logInfo("HTTP and runtime config loaded.");
    logInfo(`Public legal pages enabled: ${getLegalDocuments().length}`);
    if (config.publicVideo) logInfo("Public video page enabled.");
    if (defaultQurlConnectorUrl) logInfo("qURL Connector uploads enabled.");
    const smtpInspection = inspectSmtpConfig(runtimeConfigPath);
    logInfo(
      smtpInspection.enabled
        ? "SMTP is configured."
        : `SMTP is not configured. Missing fields: ${smtpInspection.missingFields.join(", ") || "(unknown)"}`,
    );
    if (config.allowedHosts?.length) {
      logInfo(`Host allowlist enabled with ${config.allowedHosts.length} entries.`);
    }
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(sweepTimer);
    logInfo(`Received ${signal}; draining HTTP connections and MCP sessions.`);

    const forceCloseTimer = setTimeout(() => {
      httpServer.closeAllConnections();
    }, 10_000);
    forceCloseTimer.unref();

    httpServer.close((error) => {
      void closeAllSessions().finally(() => {
        clearTimeout(forceCloseTimer);
        if (error) {
          console.error(`HTTP server shutdown failed (${formatErrorForLog(error)})`);
          process.exitCode = 1;
        }
      });
    });
  };

  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
  return httpServer;
}

const isMainModule =
  typeof process.argv[1] === "string" &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) startHttpServer();
