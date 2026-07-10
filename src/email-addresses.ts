import { z } from "zod";

const emailAddressSchema = z.email();

export function isEmailAddress(value: string): boolean {
  return emailAddressSchema.safeParse(value).success;
}

export function uniqueRecipients(recipients: string[]): string[] {
  return Array.from(
    new Set(
      recipients
        .map((recipient) => recipient.trim().toLowerCase())
        .filter((recipient) => recipient.length > 0),
    ),
  );
}
