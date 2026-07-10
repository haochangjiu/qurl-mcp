import { z } from "zod";
import type { IQURLClient } from "../client.js";
import { createTextPdfTempFile } from "../services/text-pdf.js";
import { accessPolicySchema } from "./create-qurl.js";
import { toStructuredContent, withMissingApiKeyHandler } from "./_shared.js";
import { emailDeliveryInputSchema, maybeDeliverToolEmail } from "./email-delivery.js";
import { uploadFileQurlOutputSchema } from "./output-schemas.js";
import { getConnectorConfig } from "./upload-file-shared.js";
import { uploadLocalFileAndMint } from "./upload-file-qurl.js";

const supportedTextPayloadTypes = ["text", "markdown", "html", "json"] as const;

export const uploadTextQurlSchema = z.object({
  type: z
    .enum(supportedTextPayloadTypes)
    .describe(
      "Source text type, such as `markdown`. In v1 this is preserved as metadata and the content is rendered into a plain-text PDF before upload.",
    ),
  content: z
    .string()
    .min(1)
    .max(100_000)
    .describe(
      "Text content to render into a temporary PDF before uploading to the qURL connector.",
    ),
  file_name: z
    .string()
    .min(1)
    .max(255)
    .optional()
    .describe(
      "Filename to register with the connector. The tool will normalize it to a `.pdf` filename.",
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
    .describe("Whether the link can only be used once. Defaults to true for uploaded content."),
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
      "Optional email notification settings for sending the uploaded text content's qURL to one or more recipients.",
    ),
});

export function uploadTextQurlTool(client: IQURLClient) {
  return {
    name: "upload_text_qurl",
    title: "Upload Text qURL",
    description:
      "Render text content into a temporary PDF, upload that PDF to a qURL connector, then mint an access link for it. " +
      "Use this when the user gives you text content and wants a qURL without first creating a local file or hosting a URL somewhere else. " +
      "Use `upload_file_data_qurl` for binary/image/PDF attachments, use `upload_file_qurl` when a file already exists on disk, and use `create_qurl` when you already have a target URL. " +
      "In v1 the tool does not apply markdown rich-text rendering; it writes the provided content into a plain-text PDF, uploads it to `${QURL_CONNECTOR_URL}/api/upload`, then mints a qURL from the returned `resource_id`. " +
      "If `one_time_use` is omitted, the tool defaults it to `true` to match the uploaded-content sharing flow. " +
      "Requires both `QURL_API_KEY` and `QURL_CONNECTOR_URL` in the server environment or runtime config. " +
      "**Returns:** `{ resource_id: string, qurl_id: string, qurl_link: string, qurl_site?: string, expires_at: string, file_name: string, content_type: string, size_bytes: number, branded_domain?: string, type?: string, email_delivery?: object }`.",
    inputSchema: uploadTextQurlSchema,
    outputSchema: uploadFileQurlOutputSchema,
    annotations: {
      title: "Upload Text qURL",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: withMissingApiKeyHandler(async (input: z.infer<typeof uploadTextQurlSchema>) => {
      const requestedFileName = input.file_name ?? "content.pdf";

      getConnectorConfig();

      const pdfFile = await createTextPdfTempFile({
        content: input.content,
        fileName: requestedFileName,
        title: input.label ?? requestedFileName,
      });

      try {
        const result = await uploadLocalFileAndMint(client, {
          file_path: pdfFile.filePath,
          file_name: pdfFile.fileName,
          content_type: "application/pdf",
          label: input.label,
          expires_in: input.expires_in,
          one_time_use: input.one_time_use,
          max_sessions: input.max_sessions,
          session_duration: input.session_duration,
          access_policy: input.access_policy,
        });

        const emailResult = await maybeDeliverToolEmail({
          delivery: input.email_delivery,
          defaultSubject: "Your secure text access link is ready",
          detailLines: [
            "A secure qURL text link has been created for you.",
            `File Name: ${String(result.file_name ?? pdfFile.fileName)}`,
            `Content Type: ${String(result.content_type ?? "application/pdf")}`,
            `Secure Link: ${String(result.qurl_link ?? "")}`,
            `Expires At: ${String(result.expires_at ?? "")}`,
            ...(result.qurl_site ? [`qURL Site: ${String(result.qurl_site)}`] : []),
            ...(input.label ? [`Label: ${input.label}`] : []),
            `Payload Type: ${input.type}`,
          ],
        });

        const payload = emailResult ? { ...result, email_delivery: emailResult } : result;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(payload),
            },
          ],
          structuredContent: toStructuredContent(payload),
        };
      } finally {
        try {
          await pdfFile.cleanup();
        } catch (error) {
          // Cleanup is best-effort and must not turn a successful upload into a tool failure.
          console.error(
            "Failed to clean up a temporary text PDF:",
            error instanceof Error ? error.message : "UnknownError",
          );
        }
      }
    }),
  };
}
