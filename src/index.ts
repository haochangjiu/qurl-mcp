#!/usr/bin/env node

import { createRequire } from "node:module";
import { installTimestampedConsole, logInfo } from "./logging.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MISSING_API_KEY_MESSAGE, QURLClient } from "./client.js";
import { getDefaultConfigPath, inspectSmtpConfig, loadRuntimeConfig } from "./config.js";
import { createServer } from "./server.js";

installTimestampedConsole();

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

// Trim symmetric with the apiKey path so a stray space in the URL doesn't
// produce a confusing fetch failure (DNS or scheme parse error) instead of
// being treated as unset.
//
// Intentional asymmetry vs. line 19 (`?? ""`): an empty/whitespace key is
// a misconfig the user has to fix, so we want it to land on the empty path
// where the warning fires. An empty/whitespace URL should silently fall
// back to the default — `||` collapses both `undefined` and `""` cases
// into one fallback expression.
const runtimeConfigPath = getDefaultConfigPath();
const runtimeConfig = loadRuntimeConfig(runtimeConfigPath);
const apiKey = runtimeConfig.qurlApiKey ?? "";
if (!apiKey) {
  console.error(`Warning: ${MISSING_API_KEY_MESSAGE}`);
}
const baseURL = runtimeConfig.defaultQurlApiUrl;
const smtpInspection = inspectSmtpConfig(runtimeConfigPath);
logInfo("Runtime config loaded.");
if (smtpInspection.enabled) {
  logInfo("SMTP is configured.");
} else {
  logInfo(
    `SMTP is not configured. Missing fields: ${smtpInspection.missingFields.join(", ") || "(unknown)"}`,
  );
}

const client = new QURLClient({ apiKey, baseURL });
const server = createServer(client, version, "stdio");

const transport = new StdioServerTransport();
await server.connect(transport);
