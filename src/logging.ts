type ConsoleMethodName = "warn" | "error";

const PATCH_FLAG = Symbol.for("qurl-mcp.consoleTimestampPatched");
// Keep this aligned with the qURL API-key format. Bearer-form credentials are
// redacted independently, but a bare key in an upstream error depends on this
// prefix-aware pattern.
const QURL_API_KEY_PATTERN = /\blv_[A-Za-z0-9_-]+\b/g;

function formatTimestamp(date = new Date()): string {
  return date.toISOString().replace("T", " ").replace("Z", " UTC");
}

export function logInfo(message: string): void {
  process.stderr.write(`${formatTimestamp()} ${message}\n`);
}

export function sanitizeLogValue(value: string): string {
  return value
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(QURL_API_KEY_PATTERN, "[REDACTED]")
    .replace(/[\r\n\u2028\u2029]/g, " ")
    .slice(0, 512);
}

export function formatErrorForLog(error: unknown): string {
  if (!(error instanceof Error)) return "UnknownError";
  const name = sanitizeLogValue(error.name || "Error");
  const message = sanitizeLogValue(error.message || "no message");
  return `${name}: ${message}`;
}

function prefixArgs(args: unknown[]): unknown[] {
  const prefix = `${formatTimestamp()} `;
  if (args.length === 0) {
    return [prefix.trimEnd()];
  }

  const [first, ...rest] = args;
  if (typeof first === "string") {
    return [`${prefix}${first}`, ...rest];
  }

  return [prefix, first, ...rest];
}

export function installTimestampedConsole(): void {
  const globalConsole = console as typeof console & { [PATCH_FLAG]?: boolean };
  if (globalConsole[PATCH_FLAG]) {
    return;
  }

  // stdout is reserved for JSON-RPC in stdio mode. Only patch the two methods
  // this project permits, both of which write to stderr in Node.js.
  const methods: ConsoleMethodName[] = ["warn", "error"];
  for (const method of methods) {
    const original = globalConsole[method].bind(globalConsole);
    Object.defineProperty(globalConsole, method, {
      configurable: true,
      value: (...args: unknown[]) => original(...prefixArgs(args)),
      writable: true,
    });
  }

  globalConsole[PATCH_FLAG] = true;
}
