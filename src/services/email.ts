import nodemailer from "nodemailer";
import { loadRuntimeConfig } from "../config.js";
import type { EmailDeliveryRecipientResult, EmailDeliveryResult } from "../email-types.js";

export interface EmailMessageInput {
  to: string[];
  subject: string;
  text: string;
}

function uniqueRecipients(recipients: string[]): string[] {
  return Array.from(
    new Set(
      recipients
        .map((recipient) => recipient.trim().toLowerCase())
        .filter((recipient) => recipient.length > 0),
    ),
  );
}

export async function sendEmailMessage(input: EmailMessageInput): Promise<EmailDeliveryResult> {
  const recipients = uniqueRecipients(input.to);
  if (recipients.length === 0) {
    return {
      attempted: false,
      enabled: false,
      skipped_reason: "No email recipients were provided.",
    };
  }

  const smtp = loadRuntimeConfig().smtp;
  if (!smtp) {
    return {
      attempted: false,
      enabled: false,
      recipients,
      skipped_reason: "SMTP is not configured.",
    };
  }

  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: {
      user: smtp.username,
      pass: smtp.password,
    },
  });

  const from = smtp.fromName ? { name: smtp.fromName, address: smtp.fromEmail } : smtp.fromEmail;

  const results: EmailDeliveryRecipientResult[] = [];
  for (const recipient of recipients) {
    try {
      const sent = await transporter.sendMail({
        from,
        to: recipient,
        subject: input.subject,
        text: input.text,
      });
      results.push({
        email: recipient,
        success: true,
        message_id: sent.messageId,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      results.push({
        email: recipient,
        success: false,
        error: errorMessage,
      });
    }
  }

  const sentCount = results.filter((result) => result.success).length;
  return {
    attempted: true,
    enabled: true,
    recipients,
    sent: sentCount,
    failed: results.length - sentCount,
    results,
  };
}
