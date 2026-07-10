import { Buffer } from "node:buffer";
import { basename, extname } from "node:path";
import { getRequestQurlApiKey, getRequestQurlConnectorUrl } from "../auth/request-context.js";
import { MISSING_API_KEY_MESSAGE, QURLAPIError } from "../client.js";
import { loadRuntimeConfig } from "../config.js";

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
  let uploadUrl: URL;
  try {
    uploadUrl = new URL(`${connectorURL.replace(/\/$/, "")}/api/upload`);
  } catch {
    throw new QURLAPIError(
      0,
      "invalid_connector_url",
      "QURL_CONNECTOR_URL must be a valid absolute URL.",
    );
  }

  if (uploadUrl.username || uploadUrl.password) {
    throw new QURLAPIError(
      0,
      "invalid_connector_url",
      "QURL_CONNECTOR_URL must not contain embedded credentials.",
    );
  }
  if (
    uploadUrl.protocol !== "https:" &&
    !(uploadUrl.protocol === "http:" && isLoopbackHostname(uploadUrl.hostname))
  ) {
    throw new QURLAPIError(
      0,
      "invalid_connector_url",
      "QURL_CONNECTOR_URL must use HTTPS, except for loopback development endpoints.",
    );
  }

  return uploadUrl.toString();
}

export function normalizeFileName(input: string) {
  const name = basename(input).trim();
  if (!name) {
    throw new Error("file_name must not be empty");
  }
  return name;
}

export function inferContentType(filePath: string) {
  return mimeTypeByExtension.get(extname(filePath).toLowerCase());
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
  if ("resource_id" in parsed && typeof parsed.resource_id === "string") {
    return parsed.resource_id;
  }

  // Wrapped shape: { data: { resource_id: string } }
  if (
    "data" in parsed &&
    typeof parsed.data === "object" &&
    parsed.data !== null &&
    "resource_id" in parsed.data &&
    typeof parsed.data.resource_id === "string"
  ) {
    return parsed.data.resource_id;
  }

  return undefined;
}

/**
 * Process connector response and extract resource_id.
 * Throws QURLAPIError on failure or missing resource_id.
 */
async function processConnectorResponse(response: Response): Promise<ConnectorUploadResponse> {
  const requestId = response.headers.get("x-request-id") ?? undefined;
  const raw = await response.text();
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
  const response = await fetch(uploadUrl, {
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
  const response = await fetch(uploadUrl, {
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
