import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { IQURLClient } from "../client.js";
import { formatErrorForLog } from "../logging.js";
import { accessPolicySchema } from "./create-qurl.js";
import { toStructuredContent, withMissingApiKeyHandler } from "./_shared.js";
import {
  getConnectorConfig,
  getMaxUploadFileBytes,
  inferContentType,
  normalizeFileName,
  supportedMimeTypes,
  uploadToConnector,
  validateFileNameContentType,
  validateFileSignature,
  type ConnectorConfig,
} from "./upload-file-shared.js";
import { uploadFileQurlOutputSchema } from "./output-schemas.js";

export const uploadFileQurlSchema = z.object({
  file_path: z
    .string()
    .min(1)
    .max(4096)
    .describe("Path to a local PDF or raster image file on the MCP server host"),
  file_name: z
    .string()
    .min(1)
    .max(255)
    .optional()
    .describe("Optional override for the uploaded filename; defaults to the source basename"),
  content_type: z
    .enum(supportedMimeTypes)
    .optional()
    .describe(
      "Optional MIME type override. Supported: application/pdf, image/png, image/jpeg, image/webp, image/gif",
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
});

export type UploadFileQurlInput = z.infer<typeof uploadFileQurlSchema>;

export async function uploadLocalFileAndMint(
  client: IQURLClient,
  input: UploadFileQurlInput,
  connectorConfig: ConnectorConfig = getConnectorConfig(),
) {
  // Preflight config before reading local files so misconfigured hosts fail fast.
  const sourcePath = resolve(input.file_path);
  const fileName = normalizeFileName(input.file_name ?? sourcePath);
  const contentType = input.content_type ?? inferContentType(fileName);
  if (!contentType) {
    throw new Error(
      "Unsupported file type. Provide a PDF, PNG, JPEG, WEBP, or GIF file, or set content_type explicitly.",
    );
  }

  validateFileNameContentType(fileName, contentType);

  const maxBytes = getMaxUploadFileBytes();
  const fileHandle = await open(sourcePath, "r");
  let fileData: Uint8Array;
  try {
    const sourceStat = await fileHandle.stat();
    if (!sourceStat.isFile()) throw new Error("file_path must point to a regular file");
    if (sourceStat.size > maxBytes) {
      throw new Error("File exceeds the configured upload size limit.");
    }
    fileData = await fileHandle.readFile();
  } finally {
    await fileHandle.close();
  }
  if (fileData.byteLength > maxBytes) {
    throw new Error("File exceeds the configured upload size limit.");
  }
  validateFileSignature(fileData, contentType);
  const upload = await uploadToConnector(fileData, fileName, contentType, connectorConfig);

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
      `Failed to fetch qurl_site for resource ${upload.resource_id} (${formatErrorForLog(err)})`,
    );
    qurlSite = undefined;
  }

  return {
    resource_id: upload.resource_id,
    qurl_id: minted.data.qurl_id,
    qurl_link: minted.data.qurl_link,
    qurl_site: qurlSite,
    expires_at: minted.data.expires_at,
    file_name: fileName,
    content_type: contentType,
    size_bytes: fileData.byteLength,
    branded_domain: minted.data.branded_domain,
    type: minted.data.type,
  };
}

export function uploadFileQurlTool(client: IQURLClient) {
  return {
    name: "upload_file_qurl",
    title: "Upload File qURL",
    description:
      "Upload a local PDF or raster image file to a qURL connector, then mint an access link for it. " +
      "Use this when the content already exists on the MCP server host and you need a shareable file qURL rather than a proxy to an existing website URL. " +
      "This stdio-only tool can read any supported file that the local MCP process user can access; invoke it only for a path the user explicitly chose to share. " +
      "Use `create_qurl` when you already have a URL, and use `mint_link` when the file has already been uploaded and you only need another token. " +
      "The tool reads `file_path`, uploads the file to `${QURL_CONNECTOR_URL}/api/upload`, then mints a qURL from the returned `resource_id`. " +
      "If `one_time_use` is omitted, the tool defaults it to `true` for safer file distribution. " +
      "Requires both `QURL_API_KEY` and `QURL_CONNECTOR_URL` in the server environment or runtime config. " +
      "**Returns:** `{ resource_id: string, qurl_id: string, qurl_link: string, qurl_site?: string, expires_at: string, file_name: string, content_type: string, size_bytes: number, branded_domain?: string, type?: string }`.",
    inputSchema: uploadFileQurlSchema,
    outputSchema: uploadFileQurlOutputSchema,
    annotations: {
      title: "Upload File qURL",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: withMissingApiKeyHandler(async (input: UploadFileQurlInput) => {
      const result = await uploadLocalFileAndMint(client, input);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result),
          },
        ],
        structuredContent: toStructuredContent(result),
      };
    }),
  };
}
