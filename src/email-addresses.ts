export function isEmailAddress(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
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
