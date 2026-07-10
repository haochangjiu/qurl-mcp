import { Buffer } from "node:buffer";
import { basename, extname } from "node:path";
import {
  getRequestMaxUploadFileDataBytes,
  getRequestQurlApiKey,
  getRequestQurlConnectorUrl,
} from "../auth/request-context.js";
import { MISSING_API_KEY_MESSAGE, QURLAPIError } from "../client.js";
import {
  DEFAULT_MAX_UPLOAD_FILE_DATA_BYTES,
  loadRuntimeConfig,
  parseSizeBytes,
} from "../config.js";

export const supportedMimeTypes = [
  "application/pdf",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export const mimeTypeByExtension = new Map<string, (typeof supportedMimeTypes)[number]>([
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);

type ConnectorUploadResponse = {
  resource_id: string;
};

type ConnectorErrorBody = {
  error?: { code?: string; detail?: string; message?: string; type?: string; instance?: string };
  code?: string;
  detail?: string;
  message?: string;
};

export function getConnectorConfig() {
  const apiKey =
    getRequestQurlApiKey() ??
    process.env.QURL_API_KEY?.trim() ??
    loadRuntimeConfig().qurlApiKey ??
    "";
  if (!apiKey) {
    throw new QURLAPIError(0, "missing_api_key", MISSING_API_KEY_MESSAGE);
  }

  const connectorURL =
    getRequestQurlConnectorUrl() ??
    process.env.QURL_CONNECTOR_URL?.trim() ??
    loadRuntimeConfig().defaultQurlConnectorUrl ??
    "";
  if (!connectorURL) {
    throw new QURLAPIError(
      0,
      "missing_connector_url",
      "QURL_CONNECTOR_URL is not set. Set it in the MCP server environment or runtime config to enable file uploads.",
    );
  }

  return {
    apiKey,
    connectorURL: connectorURL.replace(/\/$/, ""),
  };
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export function getConnectorUploadUrl(connectorURL: string): string {
  let connectorBaseUrl: URL;
  try {
    connectorBaseUrl = new URL(connectorURL);
  } catch {
    throw new QURLAPIError(
      0,
      "invalid_connector_url",
      "QURL_CONNECTOR_URL must be a valid absolute URL.",
    );
  }

  if (connectorBaseUrl.username || connectorBaseUrl.password) {
    throw new QURLAPIError(
      0,
      "invalid_connector_url",
      "QURL_CONNECTOR_URL must not contain embedded credentials.",
    );
  }
  if (connectorBaseUrl.search || connectorBaseUrl.hash) {
    throw new QURLAPIError(
      0,
      "invalid_connector_url",
      "QURL_CONNECTOR_URL must not contain a query string or fragment.",
    );
  }
  if (
    connectorBaseUrl.protocol !== "https:" &&
    !(connectorBaseUrl.protocol === "http:" && isLoopbackHostname(connectorBaseUrl.hostname))
  ) {
    throw new QURLAPIError(
      0,
      "invalid_connector_url",
      "QURL_CONNECTOR_URL must use HTTPS, except for loopback development endpoints.",
    );
  }

  connectorBaseUrl.pathname = `${connectorBaseUrl.pathname.replace(/\/$/, "")}/api/upload`;
  return connectorBaseUrl.toString();
}

export function normalizeFileName(input: string) {
  const name = basename(input.replaceAll("\\", "/")).trim();
  if (!name || name === "." || name === "..") {
    throw new Error("file_name must not be empty");
  }
  const hasControlCharacter = [...name].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
  if (name.length > 255 || hasControlCharacter) {
    throw new Error("file_name must be at most 255 characters and contain no control characters");
  }
  return name;
}

export function inferContentType(filePath: string) {
  return mimeTypeByExtension.get(extname(filePath).toLowerCase());
}

export function getMaxUploadFileBytes(): number {
  const requestScoped = getRequestMaxUploadFileDataBytes();
  if (requestScoped) return requestScoped;
  if (process.env.MCP_MAX_UPLOAD_FILE_DATA_BYTES) {
    return parseSizeBytes(
      process.env.MCP_MAX_UPLOAD_FILE_DATA_BYTES,
      DEFAULT_MAX_UPLOAD_FILE_DATA_BYTES,
      "MCP_MAX_UPLOAD_FILE_DATA_BYTES",
    );
  }
  return loadRuntimeConfig().maxUploadFileDataBytes;
}

export function validateFileNameContentType(fileName: string, contentType: string): void {
  const inferred = inferContentType(fileName);
  if (inferred && inferred !== contentType) {
    throw new Error(`content_type ${contentType} does not match the filename extension.`);
  }
}

export function validateFileSignature(fileData: Uint8Array, contentType: string): void {
  const bytes = Buffer.from(fileData);
  const ascii = (start: number, end: number) => bytes.subarray(start, end).toString("ascii");
  const valid =
    (contentType === "application/pdf" &&
      ascii(0, Math.min(bytes.length, 1024)).includes("%PDF-")) ||
    (contentType === "image/png" &&
      bytes.length >= 8 &&
      bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
    (contentType === "image/jpeg" &&
      bytes.length >= 3 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff) ||
    (contentType === "image/gif" && ["GIF87a", "GIF89a"].includes(ascii(0, 6))) ||
    (contentType === "image/webp" &&
      bytes.length >= 12 &&
      ascii(0, 4) === "RIFF" &&
      ascii(8, 12) === "WEBP");
  if (!valid) {
    throw new Error(`File content does not match declared content_type ${contentType}.`);
  }
}

/**
 * Parse JSON response body safely, returning undefined on parse failure.
 */
function parseJsonBody(raw: string): unknown {
  try {
    return raw ? (JSON.parse(raw) as unknown) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Extract error details from connector error response body.
 */
function extractErrorDetail(parsed: unknown, rawFallback: string): string {
  const errorBody = (parsed ?? {}) as ConnectorErrorBody;
  return (
    errorBody.error?.detail ??
    errorBody.error?.message ??
    errorBody.detail ??
    errorBody.message ??
    rawFallback
  );
}

/**
 * Extract error code from connector error response body.
 */
function extractErrorCode(parsed: unknown): string {
  const errorBody = (parsed ?? {}) as ConnectorErrorBody;
  return errorBody.error?.code ?? errorBody.code ?? "connector_upload_failed";
}

/**
 * Extract error type and instance from connector error response body.
 */
function extractErrorMetadata(parsed: unknown): { type?: string; instance?: string } {
  const errorBody = (parsed ?? {}) as ConnectorErrorBody;
  return {
    type: errorBody.error?.type,
    instance: errorBody.error?.instance,
  };
}

/**
 * Throw a QURLAPIError from a failed connector response.
 */
function throwConnectorError(
  response: Response,
  parsed: unknown,
  raw: string,
  requestId?: string,
): never {
  const detail = extractErrorDetail(parsed, raw);
  const { type, instance } = extractErrorMetadata(parsed);
  throw new QURLAPIError(
    response.status,
    extractErrorCode(parsed),
    detail || `Connector upload failed with HTTP ${response.status}`,
    type,
    instance,
    requestId,
  );
}

/**
 * Extract resource_id from connector success response.
 * Handles both `{ resource_id }` and `{ data: { resource_id } }` shapes.
 */
function extractResourceId(parsed: unknown): string | undefined {
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }

  // Direct shape: { resource_id: string }
  if (
    "resource_id" in parsed &&
    typeof parsed.resource_id === "string" &&
    /^r_[a-z0-9_-]{11}$/.test(parsed.resource_id)
  ) {
    return parsed.resource_id;
  }

  // Wrapped shape: { data: { resource_id: string } }
  if (
    "data" in parsed &&
    typeof parsed.data === "object" &&
    parsed.data !== null &&
    "resource_id" in parsed.data &&
    typeof parsed.data.resource_id === "string" &&
    /^r_[a-z0-9_-]{11}$/.test(parsed.data.resource_id)
  ) {
    return parsed.data.resource_id;
  }

  return undefined;
}

async function readConnectorResponseBody(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > 64 * 1024) {
      await reader.cancel();
      throw new QURLAPIError(
        0,
        "connector_response_too_large",
        "Connector response exceeded the 64 KiB limit.",
      );
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Process connector response and extract resource_id.
 * Throws QURLAPIError on failure or missing resource_id.
 */
async function processConnectorResponse(response: Response): Promise<ConnectorUploadResponse> {
  const requestId = response.headers.get("x-request-id") ?? undefined;
  const raw = await readConnectorResponseBody(response);
  const parsed = parseJsonBody(raw);

  if (!response.ok) {
    throwConnectorError(response, parsed, raw, requestId);
  }

  const resourceId = extractResourceId(parsed);
  if (!resourceId) {
    throw new QURLAPIError(
      0,
      "unexpected_response",
      "Connector upload succeeded but did not return a resource_id.",
      undefined,
      undefined,
      requestId,
    );
  }

  return { resource_id: resourceId };
}

async function fetchConnector(
  uploadUrl: string,
  init: NonNullable<Parameters<typeof fetch>[1]>,
): Promise<Response> {
  try {
    return await fetch(uploadUrl, { ...init, signal: globalThis.AbortSignal.timeout(60_000) });
  } catch (error) {
    const code =
      error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)
        ? "connector_timeout"
        : "connector_unreachable";
    throw new QURLAPIError(
      0,
      code,
      code === "connector_timeout"
        ? "Connector upload timed out."
        : "Connector upload request failed.",
    );
  }
}

export async function uploadToConnector(
  fileData: Uint8Array,
  fileName: string,
  contentType: string,
): Promise<ConnectorUploadResponse> {
  const { apiKey, connectorURL } = getConnectorConfig();
  const uploadUrl = getConnectorUploadUrl(connectorURL);
  const form = new globalThis.FormData();
  form.append(
    "file",
    // lgtm[js/file-access-to-http] This tool explicitly uploads caller-provided bytes to the operator-configured connector.
    new globalThis.Blob([Buffer.from(fileData)], { type: contentType }),
    fileName,
  );

  // lgtm[js/file-access-to-http] The validated destination and upload are the explicit behavior of this MCP tool.
  const response = await fetchConnector(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
    body: form, // lgtm[js/file-access-to-http]
  });

  return processConnectorResponse(response);
}

export async function uploadTextToConnector(
  text: string,
  fileName: string,
  contentType: string,
): Promise<ConnectorUploadResponse> {
  return uploadToConnector(Buffer.from(text, "utf8"), fileName, contentType);
}

export async function uploadJsonToConnector(
  payload: Record<string, unknown>,
): Promise<ConnectorUploadResponse> {
  const { apiKey, connectorURL } = getConnectorConfig();
  const uploadUrl = getConnectorUploadUrl(connectorURL);
  const body = JSON.stringify(payload); // lgtm[js/file-access-to-http] Explicit connector upload payload.
  // lgtm[js/file-access-to-http] The validated destination and upload are the explicit behavior of this MCP tool.
  const response = await fetchConnector(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body, // lgtm[js/file-access-to-http]
  });

  return processConnectorResponse(response);
}
