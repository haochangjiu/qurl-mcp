export function isControlCodePoint(codePoint: number): boolean {
  return codePoint <= 31 || codePoint === 127;
}
