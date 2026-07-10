import { Buffer } from "node:buffer";
import { hkdf, randomBytes } from "node:crypto";
import nodemailer from "nodemailer";
import { getRequestQurlApiKey } from "../auth/request-context.js";
import { loadRuntimeConfig } from "../config.js";
import type { EmailDeliveryRecipientResult, EmailDeliveryResult } from "../email-types.js";

export interface EmailMessageInput {
  to: string[];
  subject: string;
  text: string;
}

export interface EmailMessageOptions {
  allowServerApiKeyFallback?: boolean;
}

type EmailQuota = { recipients: number; windowStartedAt: number };
const emailQuotaByPrincipal = new Map<string, EmailQuota>();
const EMAIL_QUOTA_WINDOW_MS = 60 * 60 * 1000;
const EMAIL_QUOTA_SALT = randomBytes(16);

export function clearEmailQuotaState(): void {
  emailQuotaByPrincipal.clear();
}

async function deriveEmailQuotaPrincipal(principalKey: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // qURL API keys are high-entropy credentials, so HKDF is the appropriate
    // low-cost one-way derivation. A password KDF such as scrypt adds latency
    // without improving resistance to guessing attacks here.
    hkdf("sha256", principalKey, EMAIL_QUOTA_SALT, "qurl-mcp-email-quota", 32, (error, key) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(Buffer.from(key).toString("hex"));
    });
  });
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

export async function sendEmailMessage(
  input: EmailMessageInput,
  options: EmailMessageOptions = {},
): Promise<EmailDeliveryResult> {
  const recipients = uniqueRecipients(input.to);
  if (recipients.length === 0) {
    return {
      attempted: false,
      enabled: false,
      skipped_reason: "No email recipients were provided.",
    };
  }
  if (recipients.some((recipient) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient))) {
    throw new Error("Email recipients must be valid addresses.");
  }
  if (!input.subject.trim() || input.subject.length > 200 || /[\r\n]/.test(input.subject)) {
    throw new Error("Email subject must be a non-empty single line.");
  }
  if (input.text.length > 10_000) throw new Error("Email text exceeds the 10,000 character limit.");

  const runtimeConfig = loadRuntimeConfig();
  const smtp = runtimeConfig.smtp;
  if (!smtp) {
    return {
      attempted: false,
      enabled: false,
      recipients,
      skipped_reason: "SMTP is not configured.",
    };
  }

  if (recipients.length > smtp.maxRecipientsPerMessage) {
    return {
      attempted: false,
      enabled: true,
      recipients,
      skipped_reason: `Recipient count exceeds the configured per-message limit of ${smtp.maxRecipientsPerMessage}.`,
    };
  }

  const exactAllowlist = new Set(smtp.allowedRecipients ?? []);
  const domainAllowlist = new Set(smtp.allowedRecipientDomains ?? []);
  const hasRecipientRestrictions = exactAllowlist.size > 0 || domainAllowlist.size > 0;
  const allowedRecipients = recipients.filter((recipient) => {
    if (!hasRecipientRestrictions) return true;
    const domain = recipient.slice(recipient.lastIndexOf("@") + 1);
    return exactAllowlist.has(recipient) || domainAllowlist.has(domain);
  });
  const blockedRecipients = recipients.filter(
    (recipient) => !allowedRecipients.includes(recipient),
  );

  if (allowedRecipients.length === 0) {
    return {
      attempted: false,
      enabled: true,
      recipients,
      failed: blockedRecipients.length,
      skipped_reason: "No recipient matched the configured SMTP recipient allowlist.",
      results: blockedRecipients.map((email) => ({
        email,
        success: false,
        skipped: true,
        error: "Recipient is not allowed by SMTP policy.",
      })),
    };
  }

  const requestApiKey = getRequestQurlApiKey();
  if (options.allowServerApiKeyFallback === false && !requestApiKey) {
    throw new Error("Request-scoped qURL credentials are unavailable for email quota tracking.");
  }
  const principalKey = requestApiKey ?? runtimeConfig.qurlApiKey ?? "unscoped";
  const principal = await deriveEmailQuotaPrincipal(principalKey);
  const now = Date.now();
  for (const [key, quota] of emailQuotaByPrincipal) {
    if (now - quota.windowStartedAt >= EMAIL_QUOTA_WINDOW_MS) emailQuotaByPrincipal.delete(key);
  }
  if (!emailQuotaByPrincipal.has(principal) && emailQuotaByPrincipal.size >= 10_000) {
    return {
      attempted: false,
      enabled: true,
      recipients,
      skipped_reason: "Email quota tracking capacity has been reached. Try again later.",
    };
  }
  const quota = emailQuotaByPrincipal.get(principal) ?? { recipients: 0, windowStartedAt: now };
  if (quota.recipients + allowedRecipients.length > smtp.maxRecipientsPerHour) {
    return {
      attempted: false,
      enabled: true,
      recipients,
      skipped_reason: `Recipient quota exceeds the configured per-key hourly limit of ${smtp.maxRecipientsPerHour}.`,
    };
  }
  // Count attempted recipients, not only successful sends. Refunding failures
  // would let a failing or adversarial SMTP destination bypass the abuse cap
  // by retrying indefinitely.
  quota.recipients += allowedRecipients.length;
  emailQuotaByPrincipal.set(principal, quota);

  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: {
      user: smtp.username,
      pass: smtp.password,
    },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });

  const from = smtp.fromName ? { name: smtp.fromName, address: smtp.fromEmail } : smtp.fromEmail;

  const results: EmailDeliveryRecipientResult[] = blockedRecipients.map((email) => ({
    email,
    success: false,
    skipped: true,
    error: "Recipient is not allowed by SMTP policy.",
  }));
  try {
    for (const recipient of allowedRecipients) {
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
  } finally {
    transporter.close();
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
