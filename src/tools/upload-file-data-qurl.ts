import { Buffer } from "node:buffer";
import { z } from "zod";
import { getRequestMaxUploadFileDataBytes } from "../auth/request-context.js";
import type { IQURLClient } from "../client.js";
import {
  DEFAULT_MAX_UPLOAD_FILE_DATA_BYTES,
  loadRuntimeConfig,
  parseSizeBytes,
} from "../config.js";
import { accessPolicySchema } from "./create-qurl.js";
import { toStructuredContent, withMissingApiKeyHandler } from "./_shared.js";
import { emailDeliveryInputSchema, maybeDeliverToolEmail } from "./email-delivery.js";
import {
  getConnectorConfig,
  normalizeFileName,
  supportedMimeTypes,
  uploadToConnector,
} from "./upload-file-shared.js";
import { uploadFileQurlOutputSchema } from "./output-schemas.js";

export const uploadFileDataQurlSchema = z.object({
  file_base64: z
    .string()
    .min(1)
    .describe(
      "Base64-encoded PDF or raster image content. Raw base64 and data URLs are both accepted. For compressible images, compress them first and then convert them to base64 before calling this tool.",
    ),
  file_name: z
    .string()
    .min(1)
    .describe(
      "Filename to register with the connector. `.jpg` and `.jpeg` files should use `image/jpeg`.",
    ),
  content_type: z
    .enum(supportedMimeTypes)
    .describe(
      "MIME type for the uploaded file. Supported: application/pdf, image/png, image/jpeg, image/webp, image/gif.",
    ),
  label: z
    .string()
    .max(500)
    .optional()
    .describe("Human-readable label identifying who this qURL is for (max 500 chars)"),
  expires_in: z.string().min(1).optional().describe('Duration string (e.g., "1h", "24h", "7d")'),
  one_time_use: z
    .boolean()
    .optional()
    .describe("Whether the link can only be used once. Defaults to true for uploaded files."),
  max_sessions: z
    .number()
    .int()
    .min(0)
    .max(1000)
    .optional()
    .describe("Maximum concurrent sessions for this qURL token (0 = unlimited, max 1000)"),
  session_duration: z
    .string()
    .min(1)
    .optional()
    .describe('How long access lasts after clicking (e.g., "1h")'),
  access_policy: accessPolicySchema.optional().describe("Access control policy for this link"),
  email_delivery: emailDeliveryInputSchema
    .optional()
    .describe(
      "Optional email notification settings for sending the uploaded file's qURL to one or more recipients.",
    ),
});

function getMaxUploadFileDataBytes(): number {
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

/**
 * Normalize and validate base64 input for file upload.
 *
 * Accepts multiple input formats:
 * - Raw base64: "SGVsbG8gV29ybGQ="
 * - Data URL: "data:image/png;base64,iVBORw0KGgo..."
 * - Base64 with whitespace (e.g., line breaks from copy-paste)
 * - URL-safe base64 (uses - and _ instead of + and /)
 *
 * @param input - Raw base64 string or data URL
 * @returns Normalized standard base64 string with proper padding
 * @throws Error if input is empty or contains invalid base64 characters
 */
function normalizeBase64Input(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("file_base64 must not be empty");
  }

  // Step 1: Strip data URL prefix if present (e.g., "data:image/png;base64,")
  const withoutDataUrl = trimmed.replace(/^data:[^;,]+;base64,/i, "");

  // Step 2: Remove whitespace (base64 from copy-paste often has line breaks)
  const withoutWhitespace = withoutDataUrl.replace(/\s+/g, "");

  // Step 3: Convert URL-safe base64 to standard base64
  // URL-safe uses '-' instead of '+' and '_' instead of '/'
  const normalized = withoutWhitespace.replace(/-/g, "+").replace(/_/g, "/");
  if (!normalized) {
    throw new Error("file_base64 must not be empty");
  }

  // Step 4: Validate character set (A-Z, a-z, 0-9, +, /, and up to 2 trailing =)
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new Error("file_base64 must be valid base64-encoded content");
  }

  // Step 5: Validate and fix padding
  // Base64 length must be divisible by 4. Valid lengths mod 4 are: 0, 2, 3
  // Length mod 4 = 1 is always invalid (would represent 6 bits, not enough for a byte)
  const paddingNeeded = normalized.length % 4;
  if (paddingNeeded === 1) {
    throw new Error("file_base64 must be valid base64-encoded content");
  }

  // Already properly padded
  if (paddingNeeded === 0) {
    return normalized;
  }

  // Add missing padding (mod 4 = 2 needs "==", mod 4 = 3 needs "=")
  return normalized.padEnd(normalized.length + (4 - paddingNeeded), "=");
}

function decodeBase64File(input: string, maxBytes: number): Uint8Array {
  const normalized = normalizeBase64Input(input);
  const fileData = Buffer.from(normalized, "base64");

  if (fileData.byteLength === 0) {
    throw new Error("file_base64 decoded to an empty file");
  }

  if (fileData.byteLength > maxBytes) {
    throw new Error(
      "Decoded file exceeds the allowed upload size. Reduce the file size and try again.",
    );
  }

  return fileData;
}

export function uploadFileDataQurlTool(client: IQURLClient) {
  return {
    name: "upload_file_data_qurl",
    title: "Upload File Data qURL",
    description:
      "Upload base64-encoded PDF or raster image content to a qURL connector, then mint an access link for it. " +
      "This is the correct tool for a single image, PDF, or file attachment in HTTP MCP mode, especially when the user wants 'the qURL of this image/file' or wants the generated link emailed. " +
      "Use this when you have the file data available but cannot provide a server-local file path. " +
      "Use `upload_file_qurl` when the file already exists on the MCP server host, use `create_qurl` when you already have a URL, and use `mint_link` when the file has already been uploaded and you only need another token. " +
      "For compressible images, compress them before converting to base64 so the request is smaller and more reliable. " +
      "The tool decodes `file_base64`, uploads the file to `${QURL_CONNECTOR_URL}/api/upload`, then mints a qURL from the returned `resource_id`. " +
      "Supported MIME types are application/pdf, image/png, image/jpeg, image/webp, and image/gif. " +
      "If `one_time_use` is omitted, the tool defaults it to `true` to match the file-distribution flow in `file-upload-distribution-design.md`. " +
      "Requires both `QURL_API_KEY` and `QURL_CONNECTOR_URL` in the server environment or runtime config. " +
      "**Returns:** `{ resource_id: string, qurl_id: string, qurl_link: string, qurl_site?: string, expires_at: string, file_name: string, content_type: string, size_bytes: number, branded_domain?: string, type?: string }`.",
    inputSchema: uploadFileDataQurlSchema,
    outputSchema: uploadFileQurlOutputSchema,
    annotations: {
      title: "Upload File Data qURL",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: withMissingApiKeyHandler(async (input: z.infer<typeof uploadFileDataQurlSchema>) => {
      // Preflight connector config before decoding payloads so auth/config errors fail fast.
      getConnectorConfig();

      const fileName = normalizeFileName(input.file_name);
      const fileData = decodeBase64File(input.file_base64, getMaxUploadFileDataBytes());

      const upload = await uploadToConnector(fileData, fileName, input.content_type);

      const mintInput = {
        label: input.label,
        expires_in: input.expires_in,
        one_time_use: input.one_time_use ?? true,
        max_sessions: input.max_sessions,
        session_duration: input.session_duration,
        access_policy: input.access_policy,
      };

      const minted = await client.mintLink(upload.resource_id, mintInput);

      let qurlSite: string | undefined;
      try {
        qurlSite = (await client.getQURL(upload.resource_id)).data.qurl_site;
      } catch (err) {
        // Non-fatal: qurl_site is optional metadata. Log for debugging but don't fail the upload.
        console.error(
          `Failed to fetch qurl_site for resource ${upload.resource_id}:`,
          err instanceof Error ? err.message : err,
        );
        qurlSite = undefined;
      }

      const result = {
        resource_id: upload.resource_id,
        qurl_id: minted.data.qurl_id,
        qurl_link: minted.data.qurl_link,
        qurl_site: qurlSite,
        expires_at: minted.data.expires_at,
        file_name: fileName,
        content_type: input.content_type,
        size_bytes: fileData.byteLength,
        branded_domain: minted.data.branded_domain,
        type: minted.data.type,
      };

      const emailResult = await maybeDeliverToolEmail({
        delivery: input.email_delivery,
        defaultSubject: "Your secure file access link is ready",
        detailLines: [
          "A secure qURL file link has been created for you.",
          `File Name: ${fileName}`,
          `Content Type: ${input.content_type}`,
          `Secure Link: ${result.qurl_link}`,
          `Expires At: ${result.expires_at}`,
          ...(result.qurl_site ? [`qURL Site: ${result.qurl_site}`] : []),
          ...(input.label ? [`Label: ${input.label}`] : []),
        ],
      });
      const payload = emailResult ? { ...result, email_delivery: emailResult } : result;

      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload) }],
        structuredContent: toStructuredContent(payload),
      };
    }),
  };
}
