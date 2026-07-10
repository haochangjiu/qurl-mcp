import { z } from "zod";
import type { EmailDeliveryResult } from "../email-types.js";
import { sendEmailMessage } from "../services/email.js";

export const emailDeliveryInputSchema = z.object({
  to: z
    .array(z.string().email())
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
    .describe("Optional plain-text message to prepend above the generated qURL details."),
});

export type EmailDeliveryInput = z.infer<typeof emailDeliveryInputSchema>;

export interface ToolEmailInput {
  delivery?: EmailDeliveryInput;
  defaultSubject: string;
  detailLines: string[];
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
    return await sendEmailMessage({
      to: input.delivery.to,
      subject,
      text: sections.join("\n\n"),
    });
  } catch (error) {
    // Link creation has already succeeded when this helper runs. Never turn a
    // delivery failure into a failed tool call because qurl_link is one-shot
    // output that cannot be recovered later.
    console.error(
      `Email delivery failed after qURL creation (${error instanceof Error ? error.name : "UnknownError"})`,
    );
    const recipients = Array.from(
      new Set(input.delivery.to.map((recipient) => recipient.trim().toLowerCase()).filter(Boolean)),
    );
    return {
      attempted: false,
      enabled: true,
      recipients,
      failed: recipients.length,
      skipped_reason: "Email delivery failed after the qURL was created.",
      results: recipients.map((email) => ({
        email,
        success: false,
        error: "Email delivery could not be completed.",
      })),
    };
  }
}
