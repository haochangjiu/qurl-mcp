import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { resolve } from "node:path";

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  fromEmail: string;
  fromName?: string;
  allowedRecipients?: string[];
  allowedRecipientDomains?: string[];
  maxRecipientsPerMessage: number;
  maxRecipientsPerHour: number;
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
  trustProxyHops: number;
  maxSessions: number;
  maxUnvalidatedSessions: number;
  sessionIdleTtlMs: number;
  unvalidatedSessionTtlMs: number;
  mcpRateLimitPerMinute: number;
  publicFileRateLimitPerMinute: number;
  maxUploadFileDataBytes: string | number;
  defaultQurlApiUrl: string;
  defaultQurlConnectorUrl: string;
  smtp: Partial<SmtpConfig>;
  publicVideo: Partial<PublicVideoConfig>;
}>;

const DEFAULT_CONFIG_PATH = "qurl-mcp.config.json";
export const DEFAULT_MAX_UPLOAD_FILE_DATA_BYTES = 10 * 1024 * 1024;
const MAX_UPLOAD_FILE_DATA_BYTES = 100 * 1024 * 1024;

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
    const parsed = JSON.parse(content) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Configuration file root must be a JSON object.");
    }
    return parsed as ConfigFileShape;
  } catch (error) {
    const err = error as { code?: string };
    if (error instanceof Error && err.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

export function parseAllowedHosts(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const hosts = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return hosts.length > 0 ? hosts : undefined;
}

export function parseSizeBytes(value: unknown, fallback: number, fieldName: string): number {
  if (value === undefined) return fallback;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${fieldName} must be a positive number.`);
    }
    return value;
  }
  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a positive byte size.`);
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

  const bytes = Math.floor(amount * unit);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error(`${fieldName} must be a positive byte size.`);
  }
  return bytes;
}

export function getDefaultConfigPath(): string {
  const explicitPath = process.env.QURL_MCP_CONFIG;
  if (explicitPath) {
    return resolve(process.cwd(), explicitPath);
  }
  return resolve(process.cwd(), DEFAULT_CONFIG_PATH);
}

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function parsePositiveInteger(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function trimString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("Configuration string fields must be strings.");
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  if (normalized === "localhost" || normalized === "::1") return true;
  return isIP(normalized) === 4 && Number(normalized.split(".", 1)[0]) === 127;
}

export function isInsecureNonLoopbackHttpUrl(value: string): boolean {
  const url = new URL(value);
  return url.protocol === "http:" && !isLoopbackHostname(url.hostname);
}

function normalizeServiceBaseUrl(value: string, fieldName: string, requireHttps: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${fieldName} must be a valid absolute URL.`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${fieldName} must not contain credentials, a query, or a fragment.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${fieldName} must use HTTP or HTTPS.`);
  }
  if (
    requireHttps &&
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && isLoopbackHostname(url.hostname))
  ) {
    throw new Error(`${fieldName} must use HTTPS except for loopback development endpoints.`);
  }
  return url.toString().replace(/\/$/, "");
}

function parseCsvList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" &&
    (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
  ) {
    throw new Error("SMTP recipient allowlists must be strings or arrays of strings.");
  }
  const items = (Array.isArray(value) ? value : value.split(","))
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const unique = Array.from(new Set(items));
  return unique.length > 0 ? unique : undefined;
}

export function normalizePublicPath(value: string | undefined, fallback: string): string {
  const trimmed = trimString(value);
  const path = !trimmed ? fallback : trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const segments = path.split("/");
  if (
    path === "/" ||
    !/^\/[A-Za-z0-9._~/-]+$/.test(path) ||
    path.includes("//") ||
    segments.some((segment) => segment === "." || segment === "..") ||
    ["/mcp", "/healthz", "/legal"].some(
      (reserved) => path === reserved || path.startsWith(`${reserved}/`),
    )
  ) {
    throw new Error("publicVideo.pagePath must be a non-reserved absolute URL path.");
  }
  return path.replace(/\/+$/, "");
}

function resolvePublicVideoConfig(
  fileConfig: Partial<PublicVideoConfig> | undefined,
): PublicVideoConfig | undefined {
  const filePath =
    trimString(process.env.QURL_PUBLIC_VIDEO_FILE_PATH) ?? trimString(fileConfig?.filePath);
  if (!filePath) {
    return undefined;
  }

  return {
    title:
      trimString(process.env.QURL_PUBLIC_VIDEO_TITLE) ??
      trimString(fileConfig?.title) ??
      "Video Showcase",
    pagePath: normalizePublicPath(
      trimString(process.env.QURL_PUBLIC_VIDEO_PAGE_PATH) ?? trimString(fileConfig?.pagePath),
      "/media/video",
    ),
    filePath,
  };
}

function resolveQurlApiKey(): string | undefined {
  return trimString(process.env.QURL_API_KEY);
}

function resolveSmtpConfig(fileConfig: Partial<SmtpConfig> | undefined): SmtpConfig | undefined {
  const { host, port, secure, username, password, fromEmail, fromName } =
    resolveSmtpFieldValues(fileConfig);

  if (!host || !port || secure === undefined || !username || !password || !fromEmail) {
    return undefined;
  }

  const isEmailAddress = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  if (!isEmailAddress(fromEmail)) {
    throw new Error("SMTP fromEmail must be a valid email address.");
  }
  const allowedRecipients = parseCsvList(
    process.env.QURL_SMTP_ALLOWED_RECIPIENTS ?? fileConfig?.allowedRecipients,
  );
  if (allowedRecipients?.some((recipient) => !isEmailAddress(recipient))) {
    throw new Error("SMTP allowedRecipients must contain valid email addresses.");
  }
  const allowedRecipientDomains = parseCsvList(
    process.env.QURL_SMTP_ALLOWED_RECIPIENT_DOMAINS ?? fileConfig?.allowedRecipientDomains,
  );
  if (
    allowedRecipientDomains?.some(
      (domain) =>
        !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
          domain,
        ),
    )
  ) {
    throw new Error("SMTP allowedRecipientDomains must contain valid domain names.");
  }
  const maxRecipientsPerMessage =
    parsePositiveInteger(
      process.env.QURL_SMTP_MAX_RECIPIENTS_PER_MESSAGE ?? fileConfig?.maxRecipientsPerMessage,
    ) ?? 10;
  const maxRecipientsPerHour =
    parsePositiveInteger(
      process.env.QURL_SMTP_MAX_RECIPIENTS_PER_HOUR ?? fileConfig?.maxRecipientsPerHour,
    ) ?? 100;
  if (maxRecipientsPerMessage > 100 || maxRecipientsPerHour > 100_000) {
    throw new Error("SMTP recipient limits are unreasonably high.");
  }

  return {
    host,
    port,
    secure,
    username,
    password,
    fromEmail,
    fromName,
    allowedRecipients,
    allowedRecipientDomains,
    maxRecipientsPerMessage,
    maxRecipientsPerHour,
  };
}

function resolveSmtpFieldValues(fileConfig: Partial<SmtpConfig> | undefined) {
  return {
    host: trimString(process.env.QURL_SMTP_HOST) ?? trimString(fileConfig?.host),
    port: parsePositiveInteger(process.env.QURL_SMTP_PORT ?? fileConfig?.port),
    secure: parseBoolean(process.env.QURL_SMTP_SECURE ?? fileConfig?.secure),
    username: trimString(process.env.QURL_SMTP_USERNAME) ?? trimString(fileConfig?.username),
    password: trimString(process.env.QURL_SMTP_PASSWORD) ?? trimString(fileConfig?.password),
    fromEmail: trimString(process.env.QURL_SMTP_FROM_EMAIL) ?? trimString(fileConfig?.fromEmail),
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

  const fileConfig = parseConfigFile(configPath);
  const maxUploadFileDataBytes = parseSizeBytes(
    process.env.MCP_MAX_UPLOAD_FILE_DATA_BYTES ?? fileConfig.maxUploadFileDataBytes,
    DEFAULT_MAX_UPLOAD_FILE_DATA_BYTES,
    "maxUploadFileDataBytes",
  );
  if (maxUploadFileDataBytes > MAX_UPLOAD_FILE_DATA_BYTES) {
    throw new Error("maxUploadFileDataBytes must not exceed 100mb.");
  }
  const defaultQurlApiUrl = normalizeServiceBaseUrl(
    process.env.QURL_API_URL?.trim() || fileConfig.defaultQurlApiUrl || "https://api.layerv.ai",
    "QURL_API_URL/defaultQurlApiUrl",
    false,
  );
  const connectorUrlValue =
    process.env.QURL_CONNECTOR_URL?.trim() || fileConfig.defaultQurlConnectorUrl;
  const defaultQurlConnectorUrl = connectorUrlValue
    ? normalizeServiceBaseUrl(connectorUrlValue, "QURL_CONNECTOR_URL/defaultQurlConnectorUrl", true)
    : undefined;

  const config: RuntimeConfig = {
    maxUploadFileDataBytes,
    defaultQurlApiUrl,
    defaultQurlConnectorUrl,
    qurlApiKey: resolveQurlApiKey(),
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
  return parseConfigFile(configPath);
}

export function inspectSmtpConfig(configPath = getDefaultConfigPath()): SmtpConfigInspection {
  const fileConfig = parseConfigFile(configPath);
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
