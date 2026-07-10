type ConsoleMethodName = "warn" | "error";

const PATCH_FLAG = Symbol.for("qurl-mcp.consoleTimestampPatched");

function formatTimestamp(date = new Date()): string {
  return date.toISOString().replace("T", " ").replace("Z", " UTC");
}

export function logInfo(message: string): void {
  process.stderr.write(`${formatTimestamp()} ${message}\n`);
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
