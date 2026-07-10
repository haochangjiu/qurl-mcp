import {
  getDefaultConfigPath,
  loadRuntimeConfig,
  parseAllowedHosts,
  parseConfigFile,
  type PublicVideoConfig,
} from "./config.js";
import { resolve } from "node:path";

export interface HttpServerConfig {
  port: number;
  host: string;
  baseUrl: string;
  allowedHosts?: string[];
  maxUploadFileDataBytes: number;
  defaultQurlApiUrl: string;
  defaultQurlConnectorUrl?: string;
  publicVideo?: PublicVideoConfig;
}

function trimString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizePublicPath(value: string | undefined, fallback: string): string {
  const trimmed = trimString(value);
  if (!trimmed) return fallback;
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function resolvePublicVideoFromHttpConfig(
  fileConfig: ReturnType<typeof parseConfigFile>,
): PublicVideoConfig | undefined {
  const filePath = trimString(fileConfig.publicVideo?.filePath);
  if (!filePath) return undefined;

  return {
    title: trimString(fileConfig.publicVideo?.title) ?? "Video Showcase",
    pagePath: normalizePublicPath(fileConfig.publicVideo?.pagePath, "/media/video"),
    filePath,
  };
}

const DEFAULT_HTTP_CONFIG_PATH = "qurl-mcp.http.json";

export function getDefaultHttpConfigPath(): string {
  return resolve(process.cwd(), process.env.QURL_MCP_HTTP_CONFIG ?? DEFAULT_HTTP_CONFIG_PATH);
}

export function loadHttpServerConfig(configPath = getDefaultHttpConfigPath()): HttpServerConfig {
  const fileConfig = parseConfigFile(configPath);
  const runtimeConfig = loadRuntimeConfig(getDefaultConfigPath());
  const port = Number(process.env.MCP_PORT ?? fileConfig.port ?? 3000);
  const host = process.env.MCP_HOST ?? fileConfig.host ?? "0.0.0.0";
  const baseUrl = process.env.MCP_BASE_URL ?? fileConfig.baseUrl ?? `http://127.0.0.1:${port}`;
  const allowedHosts = parseAllowedHosts(process.env.MCP_ALLOWED_HOSTS) ?? fileConfig.allowedHosts;
  const publicVideo = runtimeConfig.publicVideo ?? resolvePublicVideoFromHttpConfig(fileConfig);

  return {
    port,
    host,
    baseUrl,
    allowedHosts,
    maxUploadFileDataBytes: runtimeConfig.maxUploadFileDataBytes,
    defaultQurlApiUrl: runtimeConfig.defaultQurlApiUrl,
    defaultQurlConnectorUrl: runtimeConfig.defaultQurlConnectorUrl,
    publicVideo,
  };
}
