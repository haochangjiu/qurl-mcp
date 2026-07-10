import { Buffer } from "node:buffer";
import { basename, extname } from "node:path";
import {
  getRequestMaxUploadFileDataBytes,
  getRequestQurlApiKey,
  getRequestQurlConnectorUrl,
} from "../auth/request-context.js";
import {
  MISSING_API_KEY_MESSAGE,
  QURLAPIError,
  type IQURLClient,
  type MintLinkInput,
} from "../client.js";
import { isLoopbackHostname, loadRuntimeConfig } from "../config.js";
import { formatErrorForLog } from "../logging.js";
import { RESOURCE_ID_PATTERN } from "./_shared.js";

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

export type ConnectorConfig = {
  apiKey: string;
  connectorURL: string;
};

type ConnectorErrorBody = {
  error?: { code?: string; detail?: string; message?: string; type?: string; instance?: string };
  code?: string;
  detail?: string;
  message?: string;
};

export function getConnectorConfig(allowServerApiKeyFallback = true): ConnectorConfig {
  const serverApiKey = allowServerApiKeyFallback
    ? (process.env.QURL_API_KEY?.trim() ?? loadRuntimeConfig().qurlApiKey)
    : undefined;
  const apiKey = getRequestQurlApiKey() ?? serverApiKey ?? "";
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
  return loadRuntimeConfig().maxUploadFileDataBytes;
}

export function validateFileNameContentType(fileName: string, contentType: string): void {
  const extension = extname(fileName).toLowerCase();
  const inferred = inferContentType(fileName);
  if (extension && !inferred) {
    throw new Error("file_name must use a supported PDF or raster image extension.");
  }
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

function extractConnectorError(parsed: unknown): {
  code: string;
  detail?: string;
  type?: string;
  instance?: string;
} {
  const body = (parsed ?? {}) as ConnectorErrorBody;
  return {
    code: body.error?.code ?? body.code ?? "connector_upload_failed",
    detail: body.error?.detail ?? body.error?.message ?? body.detail ?? body.message,
    type: body.error?.type,
    instance: body.error?.instance,
  };
}

/**
 * Throw a QURLAPIError from a failed connector response.
 */
function throwConnectorError(response: Response, parsed: unknown, requestId?: string): never {
  const { code, detail, type, instance } = extractConnectorError(parsed);
  throw new QURLAPIError(
    response.status,
    code,
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
    RESOURCE_ID_PATTERN.test(parsed.resource_id)
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
    RESOURCE_ID_PATTERN.test(parsed.data.resource_id)
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
    throwConnectorError(response, parsed, requestId);
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

export async function mintUploadedFile(
  client: IQURLClient,
  resourceId: string,
  file: { name: string; contentType: string; sizeBytes: number },
  input: MintLinkInput,
) {
  const minted = await client.mintLink(resourceId, {
    label: input.label,
    expires_in: input.expires_in,
    one_time_use: input.one_time_use ?? true,
    max_sessions: input.max_sessions,
    session_duration: input.session_duration,
    access_policy: input.access_policy,
  });

  let qurlSite: string | undefined;
  try {
    qurlSite = (await client.getQURL(resourceId)).data.qurl_site;
  } catch (error) {
    // Non-fatal: qurl_site is optional metadata. Log for debugging but don't fail the upload.
    console.error(
      `Failed to fetch qurl_site for resource ${resourceId} (${formatErrorForLog(error)})`,
    );
  }

  return {
    resource_id: resourceId,
    qurl_id: minted.data.qurl_id,
    qurl_link: minted.data.qurl_link,
    qurl_site: qurlSite,
    expires_at: minted.data.expires_at,
    file_name: file.name,
    content_type: file.contentType,
    size_bytes: file.sizeBytes,
    branded_domain: minted.data.branded_domain,
    type: minted.data.type,
  };
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
  connectorConfig: ConnectorConfig,
): Promise<ConnectorUploadResponse> {
  const { apiKey, connectorURL } = connectorConfig;
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
