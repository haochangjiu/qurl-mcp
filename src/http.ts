#!/usr/bin/env node

import { createRequire } from "node:module";
import { clearTimeout, setTimeout } from "node:timers";
import { createHttpApp } from "./http-app.js";
import { loadHttpServerConfig } from "./http-config.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };
const config = loadHttpServerConfig();
const app = createHttpApp({ ...config, version });

const httpServer = app.listen(config.port, config.host, () => {
  console.warn(`qURL MCP HTTP server listening on ${config.host}:${config.port}`);
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.warn(`Received ${signal}; shutting down qURL MCP HTTP server.`);

  const forceCloseTimer = setTimeout(() => {
    httpServer.closeAllConnections();
  }, 10_000);
  forceCloseTimer.unref();

  httpServer.close((error) => {
    clearTimeout(forceCloseTimer);
    if (error) {
      console.error("HTTP server shutdown failed.");
      process.exitCode = 1;
    }
  });
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
