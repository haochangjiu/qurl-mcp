import { z } from "zod";

const emailAddressSchema = z.email();

export function isEmailAddress(value: string): boolean {
  return emailAddressSchema.safeParse(value).success;
}

export function uniqueRecipients(recipients: string[]): string[] {
  // SMTP local parts are technically case-sensitive, but modern providers
  // treat addresses case-insensitively. Canonicalizing the full address keeps
  // allowlist and per-principal quota behavior consistent.
  return Array.from(
    new Set(
      recipients
        .map((recipient) => recipient.trim().toLowerCase())
        .filter((recipient) => recipient.length > 0),
    ),
  );
}
