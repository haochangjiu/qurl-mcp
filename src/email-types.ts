import { z } from "zod";

export type EmailDeliverySetupErrorKind = "authorization" | "input" | "smtp";

export class EmailDeliverySetupError extends Error {
  constructor(
    readonly kind: EmailDeliverySetupErrorKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "EmailDeliverySetupError";
  }
}

export const emailDeliveryRecipientResultSchema = z.object({
  email: z.string(),
  success: z.boolean(),
  skipped: z.boolean().optional(),
  error: z.string().optional(),
  message_id: z.string().optional(),
});

export const emailDeliveryResultSchema = z.object({
  attempted: z.boolean(),
  enabled: z.boolean(),
  recipients: z.array(z.string()).optional(),
  sent: z.number().optional(),
  failed: z.number().optional(),
  skipped_reason: z.string().optional(),
  results: z.array(emailDeliveryRecipientResultSchema).optional(),
});

export type EmailDeliveryRecipientResult = z.infer<typeof emailDeliveryRecipientResultSchema>;
export type EmailDeliveryResult = z.infer<typeof emailDeliveryResultSchema>;
