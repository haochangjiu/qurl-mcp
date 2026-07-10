import { z } from "zod";
import { uniqueRecipients } from "../email-addresses.js";
import type { EmailDeliveryResult } from "../email-types.js";
import { formatErrorForLog } from "../logging.js";
import { sendEmailMessage } from "../services/email.js";
import { toStructuredContent } from "./_shared.js";

export const emailDeliveryInputSchema = z.object({
  to: z
    .array(z.email())
    .min(1)
    .max(100)
    .describe(
      "One or more recipient email addresses. The server's SMTP recipient policy may enforce a lower limit.",
    ),
  subject: z
    .string()
    .max(200)
    .refine((subject) => !/[\r\n]/.test(subject), "Subject must be a single line.")
    .optional()
    .describe("Optional email subject. Defaults to a tool-specific subject when omitted."),
  message: z
    .string()
    .max(5000)
    .optional()
    .describe(
      "Optional plain-text message to prepend above generated qURL details. The final assembled email is limited to 10,000 characters.",
    ),
});

export type EmailDeliveryInput = z.infer<typeof emailDeliveryInputSchema>;

export interface ToolEmailInput {
  allowServerApiKeyFallback: boolean;
  delivery?: EmailDeliveryInput;
  defaultSubject: string;
  detailLines: string[];
}

export function toEmailAugmentedResult<T extends object & { length?: never }>(
  base: T,
  emailResult: EmailDeliveryResult | undefined,
) {
  const payload = emailResult ? { ...base, email_delivery: emailResult } : base;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: toStructuredContent(payload),
  };
}

function getSanitizedDeliveryFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("Request-scoped qURL credentials")) {
    return "Email delivery authorization context was unavailable.";
  }
  if (message.startsWith("SMTP ")) {
    return "Email delivery was not attempted because SMTP configuration or connection failed.";
  }
  if (message.startsWith("Email ")) {
    return "Email delivery was not attempted because recipient or message validation failed.";
  }
  return "Email delivery was not attempted because delivery setup failed.";
}

export async function maybeDeliverToolEmail(
  input: ToolEmailInput,
): Promise<EmailDeliveryResult | undefined> {
  if (!input.delivery) return undefined;

  const subject = input.delivery.subject?.trim() || input.defaultSubject;
  const sections = [
    input.delivery.message?.trim(),
    input.detailLines.join("\n"),
    "Sent by qURL.",
  ].filter((section): section is string => typeof section === "string" && section.length > 0);

  try {
    return await sendEmailMessage(
      {
        to: input.delivery.to,
        subject,
        text: sections.join("\n\n"),
      },
      { allowServerApiKeyFallback: input.allowServerApiKeyFallback },
    );
  } catch (error) {
    // Link creation has already succeeded when this helper runs. Never turn a
    // delivery failure into a failed tool call because qurl_link is one-shot
    // output that cannot be recovered later.
    console.error(`Email delivery failed after qURL creation (${formatErrorForLog(error)})`);
    return {
      attempted: false,
      enabled: true,
      recipients: uniqueRecipients(input.delivery.to),
      skipped_reason: getSanitizedDeliveryFailureReason(error),
    };
  }
}
