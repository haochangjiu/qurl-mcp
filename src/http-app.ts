import express, { type ErrorRequestHandler, type Express, type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import {
  hostHeaderValidation,
  localhostHostValidation,
} from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  createPassthroughBearerVerifier,
  createQurlClientFromBearerToken,
} from "./auth/static-bearer.js";
import { isLoopbackHost, type HttpServerConfig } from "./http-config.js";
import { createServer } from "./server.js";

export interface HttpAppConfig extends HttpServerConfig {
  version: string;
}

function sendJsonRpcError(res: express.Response, status: number, message: string): void {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code: -32000, message },
    id: null,
  });
}

function safeErrorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

export function createHttpApp(config: HttpAppConfig): Express {
  if (!isLoopbackHost(config.host) && !config.allowedHosts?.length) {
    throw new Error("allowedHosts is required for non-loopback HTTP bindings.");
  }

  const app = express();
  app.disable("x-powered-by");
  if (config.trustProxyHops > 0) {
    app.set("trust proxy", config.trustProxyHops);
  }

  if (config.allowedHosts?.length) {
    app.use(hostHeaderValidation(config.allowedHosts));
  } else {
    app.use(localhostHostValidation());
  }

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  const limiter = rateLimit({
    windowMs: 60_000,
    limit: config.rateLimitPerMinute,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, res) => {
      sendJsonRpcError(res, 429, "Too many requests.");
    },
  });
  const bearerAuth = requireBearerAuth({
    verifier: createPassthroughBearerVerifier(),
    requiredScopes: ["mcp:tools"],
  });
  const parseJsonBody = express.json({ limit: config.maxJsonBodyBytes, strict: true });

  app.post("/mcp", limiter, bearerAuth, parseJsonBody, async (req, res) => {
    const bearerToken = req.auth?.token.trim();
    if (!bearerToken) {
      sendJsonRpcError(res, 401, "Bearer authentication required.");
      return;
    }

    const server = createServer(
      createQurlClientFromBearerToken(bearerToken, { qurlApiUrl: config.qurlApiUrl }),
      config.version,
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    let cleanupStarted = false;
    const cleanup = (): void => {
      if (cleanupStarted) return;
      cleanupStarted = true;
      void server.close().catch(() => {
        console.error("Failed to close stateless MCP server.");
      });
    };
    res.once("finish", cleanup);
    res.once("close", cleanup);

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error(`Error handling MCP request (${safeErrorName(error)}).`);
      cleanup();
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, "Internal server error.");
      }
    }
  });

  const methodNotAllowed: RequestHandler = (_req, res) => {
    res.set("Allow", "POST");
    sendJsonRpcError(res, 405, "Method not allowed.");
  };
  app.get("/mcp", limiter, bearerAuth, methodNotAllowed);
  app.delete("/mcp", limiter, bearerAuth, methodNotAllowed);

  const bodyErrorHandler: ErrorRequestHandler = (error, _req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }

    const bodyError = error as { status?: number; type?: string };
    if (bodyError.status === 413 || bodyError.type === "entity.too.large") {
      sendJsonRpcError(res, 413, "Request body is too large.");
      return;
    }
    if (error instanceof SyntaxError) {
      sendJsonRpcError(res, 400, "Request body must be valid JSON.");
      return;
    }
    next(error);
  };
  app.use(bodyErrorHandler);

  return app;
}
