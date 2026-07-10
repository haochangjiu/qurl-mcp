const DEFAULT_PORT = 3000;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_QURL_API_URL = "https://api.layerv.ai";
const DEFAULT_MAX_JSON_BODY_BYTES = 1024 * 1024;
const DEFAULT_RATE_LIMIT_PER_MINUTE = 120;

export interface HttpServerConfig {
  port: number;
  host: string;
  allowedHosts?: string[];
  trustProxyHops: number;
  maxJsonBodyBytes: number;
  rateLimitPerMinute: number;
  qurlApiUrl: string;
}

function parseInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }

  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function parseHost(value: string | undefined): string {
  const host = value?.trim() || DEFAULT_HOST;
  if (!/^[A-Za-z0-9.:[\]-]+$/.test(host)) {
    throw new Error("MCP_HOST must be a hostname or IP address without a port or URL scheme.");
  }
  return host;
}

function parseAllowedHosts(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const hosts = Array.from(
    new Set(
      value
        .split(",")
        .map((host) => host.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
  const hasInvalidHost = hosts.some((host) => {
    if (!/^[a-z0-9.:[\]-]+$/.test(host)) return true;
    try {
      const parsed = new URL(`http://${host}`);
      return parsed.hostname !== host || parsed.host !== host;
    } catch {
      return true;
    }
  });
  if (hasInvalidHost) {
    throw new Error(
      "MCP_ALLOWED_HOSTS must contain hostnames or IPs without ports or URL schemes.",
    );
  }
  return hosts.length > 0 ? hosts : undefined;
}

function parseQurlApiUrl(value: string | undefined): string {
  let url: URL;
  try {
    url = new URL(value?.trim() || DEFAULT_QURL_API_URL);
  } catch {
    throw new Error("QURL_API_URL must be a valid absolute URL.");
  }

  if (url.username || url.password || url.search || url.hash) {
    throw new Error("QURL_API_URL must not include credentials, query parameters, or a fragment.");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
    throw new Error("QURL_API_URL must use HTTPS except for loopback development endpoints.");
  }

  return url.toString().replace(/\/$/, "");
}

export function loadHttpServerConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): HttpServerConfig {
  const host = parseHost(env.MCP_HOST);
  const allowedHosts = parseAllowedHosts(env.MCP_ALLOWED_HOSTS);
  if (!isLoopbackHost(host) && !allowedHosts) {
    throw new Error("MCP_ALLOWED_HOSTS is required when MCP_HOST is not a loopback address.");
  }

  return {
    port: parseInteger(env.MCP_PORT, DEFAULT_PORT, "MCP_PORT", 1, 65535),
    host,
    allowedHosts,
    trustProxyHops: parseInteger(env.MCP_TRUST_PROXY_HOPS, 0, "MCP_TRUST_PROXY_HOPS", 0, 10),
    maxJsonBodyBytes: parseInteger(
      env.MCP_MAX_JSON_BODY_BYTES,
      DEFAULT_MAX_JSON_BODY_BYTES,
      "MCP_MAX_JSON_BODY_BYTES",
      1024,
      10 * 1024 * 1024,
    ),
    rateLimitPerMinute: parseInteger(
      env.MCP_RATE_LIMIT_PER_MINUTE,
      DEFAULT_RATE_LIMIT_PER_MINUTE,
      "MCP_RATE_LIMIT_PER_MINUTE",
      1,
      10_000,
    ),
    qurlApiUrl: parseQurlApiUrl(env.QURL_API_URL),
  };
}
