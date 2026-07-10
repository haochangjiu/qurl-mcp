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
  process.stderr.write(`${formatTimestamp()} ${sanitizeLogValue(message)}\n`);
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

export function sanitizeConsoleArgument(arg: unknown): unknown {
  if (typeof arg === "string") return sanitizeLogValue(arg);
  if (arg instanceof Error) return formatErrorForLog(arg);
  if (arg === null || ["number", "boolean", "bigint"].includes(typeof arg)) return arg;
  // Do not let console format arbitrary objects because nested credential
  // fields would bypass string redaction. Call sites that need structure must
  // select and sanitize the fields they intend to log.
  try {
    return sanitizeLogValue(String(arg));
  } catch {
    return "[unprintable]";
  }
}

function prefixArgs(args: unknown[]): unknown[] {
  const prefix = `${formatTimestamp()} `;
  if (args.length === 0) {
    return [prefix.trimEnd()];
  }

  // Make redaction the console boundary rather than a call-site convention.
  // Arbitrary objects are collapsed rather than delegated to console's deep
  // formatter, which could reveal nested credentials.
  const safeArgs = args.map(sanitizeConsoleArgument);
  const [first, ...rest] = safeArgs;
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
