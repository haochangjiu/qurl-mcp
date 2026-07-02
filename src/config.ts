import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  fromEmail: string;
  fromName?: string;
}

export interface RuntimeConfig {
  maxUploadFileDataBytes: number;
  defaultQurlApiUrl: string;
  defaultQurlConnectorUrl?: string;
  qurlApiKey?: string;
  smtp?: SmtpConfig;
  publicVideo?: PublicVideoConfig;
}

export interface PublicVideoConfig {
  title: string;
  pagePath: string;
  filePath: string;
}

export interface SmtpConfigInspection {
  enabled: boolean;
  missingFields: string[];
  host?: string;
  port?: number;
  secure?: boolean;
  username?: string;
  fromEmail?: string;
  fromName?: string;
}

export type ConfigFileShape = Partial<{
  port: number;
  host: string;
  baseUrl: string;
  allowedHosts: string[];
  maxUploadFileDataBytes: string | number;
  defaultQurlApiUrl: string;
  defaultQurlConnectorUrl: string;
  qurlApiKey: string;
  smtp: Partial<SmtpConfig>;
  publicVideo: Partial<PublicVideoConfig>;
}>;

const DEFAULT_CONFIG_PATH = "qurl-mcp.config.json";
const LEGACY_CONFIG_PATH = "qurl-mcp.http.json";
export const DEFAULT_MAX_UPLOAD_FILE_DATA_BYTES = 10 * 1024 * 1024;

/**
 * Module-level cache for runtime config. Keyed by resolved config path.
 * Config is loaded once per path and reused for the lifetime of the process.
 * Call `clearRuntimeConfigCache()` to force a reload (useful for testing).
 */
const runtimeConfigCache = new Map<string, RuntimeConfig>();

const SIZE_UNITS = new Map<string, number>([
  ["b", 1],
  ["kb", 1024],
  ["mb", 1024 * 1024],
  ["gb", 1024 * 1024 * 1024],
]);

export function parseConfigFile(configPath: string): ConfigFileShape {
  try {
    const content = readFileSync(configPath, "utf8");
    return JSON.parse(content) as ConfigFileShape;
  } catch (error) {
    const err = error as { code?: string };
    if (error instanceof Error && err.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function isEmptyConfig(config: ConfigFileShape): boolean {
  return Object.keys(config).length === 0;
}

export function parseAllowedHosts(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const hosts = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return hosts.length > 0 ? hosts : undefined;
}

export function parseSizeBytes(
  value: string | number | undefined,
  fallback: number,
  fieldName: string,
): number {
  if (value === undefined) return fallback;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${fieldName} must be a positive number.`);
    }
    return value;
  }

  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    throw new Error(`${fieldName} must not be empty.`);
  }

  if (/^\d+$/.test(trimmed)) {
    const bytes = Number(trimmed);
    if (!Number.isFinite(bytes) || bytes <= 0) {
      throw new Error(`${fieldName} must be a positive number.`);
    }
    return bytes;
  }

  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)$/.exec(trimmed);
  if (!match) {
    throw new Error(`${fieldName} must be a positive byte size like 10485760, 10mb, or 512kb.`);
  }

  const amount = Number(match[1]);
  const unit = SIZE_UNITS.get(match[2]);
  if (!Number.isFinite(amount) || amount <= 0 || !unit) {
    throw new Error(`${fieldName} must be a positive byte size.`);
  }

  return Math.floor(amount * unit);
}

export function getDefaultConfigPath(): string {
  const explicitPath = process.env.QURL_MCP_CONFIG ?? process.env.QURL_MCP_HTTP_CONFIG;
  if (explicitPath) {
    return resolve(process.cwd(), explicitPath);
  }
  return resolve(process.cwd(), DEFAULT_CONFIG_PATH);
}

function loadConfigFileWithFallback(configPath: string): ConfigFileShape {
  const primary = parseConfigFile(configPath);
  if (!isEmptyConfig(primary)) return primary;

  const normalizedPrimary = resolve(configPath);
  const defaultPrimary = resolve(process.cwd(), DEFAULT_CONFIG_PATH);
  if (normalizedPrimary !== defaultPrimary) return primary;

  return parseConfigFile(resolve(process.cwd(), LEGACY_CONFIG_PATH));
}

function parseBoolean(value: string | boolean | undefined): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function parsePositiveInteger(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === "number" ? value : Number(value.trim());
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
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

function resolvePublicVideoConfig(
  fileConfig: Partial<PublicVideoConfig> | undefined,
): PublicVideoConfig | undefined {
  const filePath = trimString(process.env.QURL_PUBLIC_VIDEO_FILE_PATH) ?? trimString(fileConfig?.filePath);
  if (!filePath) {
    return undefined;
  }

  return {
    title: trimString(process.env.QURL_PUBLIC_VIDEO_TITLE) ?? trimString(fileConfig?.title) ?? "Video Showcase",
    pagePath: normalizePublicPath(
      trimString(process.env.QURL_PUBLIC_VIDEO_PAGE_PATH) ?? trimString(fileConfig?.pagePath),
      "/media/video",
    ),
    filePath,
  };
}

function resolveQurlApiKey(fileConfig: ConfigFileShape): string | undefined {
  return trimString(process.env.QURL_API_KEY) ?? trimString(fileConfig.qurlApiKey);
}

function resolveSmtpConfig(fileConfig: Partial<SmtpConfig> | undefined): SmtpConfig | undefined {
  const { host, port, secure, username, password, fromEmail, fromName } =
    resolveSmtpFieldValues(fileConfig);

  if (!host || !port || secure === undefined || !username || !password || !fromEmail) {
    return undefined;
  }

  return {
    host,
    port,
    secure,
    username,
    password,
    fromEmail,
    fromName,
  };
}

function resolveSmtpFieldValues(fileConfig: Partial<SmtpConfig> | undefined) {
  return {
    host: trimString(process.env.QURL_SMTP_HOST) ?? trimString(fileConfig?.host),
    port: parsePositiveInteger(process.env.QURL_SMTP_PORT ?? fileConfig?.port),
    secure: parseBoolean(process.env.QURL_SMTP_SECURE ?? fileConfig?.secure),
    username: trimString(process.env.QURL_SMTP_USERNAME) ?? trimString(fileConfig?.username),
    password: trimString(process.env.QURL_SMTP_PASSWORD) ?? trimString(fileConfig?.password),
    fromEmail:
      trimString(process.env.QURL_SMTP_FROM_EMAIL) ?? trimString(fileConfig?.fromEmail),
    fromName: trimString(process.env.QURL_SMTP_FROM_NAME) ?? trimString(fileConfig?.fromName),
  };
}

/**
 * Load runtime configuration from file and environment variables.
 * Results are cached per config path to avoid repeated file reads.
 *
 * @param configPath - Path to config file (defaults to getDefaultConfigPath())
 * @returns Resolved runtime configuration
 */
export function loadRuntimeConfig(configPath = getDefaultConfigPath()): RuntimeConfig {
  const resolvedPath = resolve(configPath);
  const cached = runtimeConfigCache.get(resolvedPath);
  if (cached) {
    return cached;
  }

  const fileConfig = loadConfigFileWithFallback(configPath);
  const maxUploadFileDataBytes = parseSizeBytes(
    process.env.MCP_MAX_UPLOAD_FILE_DATA_BYTES ??
      fileConfig.maxUploadFileDataBytes ??
      "10mb",
    DEFAULT_MAX_UPLOAD_FILE_DATA_BYTES,
    "maxUploadFileDataBytes",
  );
  const defaultQurlApiUrl =
    process.env.QURL_API_URL?.trim() ||
    fileConfig.defaultQurlApiUrl ||
    "https://api.layerv.ai";
  const defaultQurlConnectorUrl =
    process.env.QURL_CONNECTOR_URL?.trim() || fileConfig.defaultQurlConnectorUrl;

  const config: RuntimeConfig = {
    maxUploadFileDataBytes,
    defaultQurlApiUrl,
    defaultQurlConnectorUrl,
    qurlApiKey: resolveQurlApiKey(fileConfig),
    smtp: resolveSmtpConfig(fileConfig.smtp),
    publicVideo: resolvePublicVideoConfig(fileConfig.publicVideo),
  };

  runtimeConfigCache.set(resolvedPath, config);
  return config;
}

/**
 * Clear the runtime config cache. Useful for testing or when config
 * files have been modified and need to be reloaded.
 */
export function clearRuntimeConfigCache(): void {
  runtimeConfigCache.clear();
}

export function loadRuntimeFileConfig(configPath = getDefaultConfigPath()): ConfigFileShape {
  return loadConfigFileWithFallback(configPath);
}

export function inspectSmtpConfig(configPath = getDefaultConfigPath()): SmtpConfigInspection {
  const fileConfig = loadConfigFileWithFallback(configPath);
  const { host, port, secure, username, password, fromEmail, fromName } = resolveSmtpFieldValues(
    fileConfig.smtp,
  );
  const missingFields = [
    !host ? "host" : undefined,
    !port ? "port" : undefined,
    secure === undefined ? "secure" : undefined,
    !username ? "username" : undefined,
    !password ? "password" : undefined,
    !fromEmail ? "fromEmail" : undefined,
  ].filter((field): field is string => typeof field === "string");

  return {
    enabled: missingFields.length === 0,
    missingFields,
    host,
    port,
    secure,
    username,
    fromEmail,
    fromName,
  };
}
