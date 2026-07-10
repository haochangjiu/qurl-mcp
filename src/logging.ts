type ConsoleMethodName = "warn" | "error";

const PATCH_FLAG = Symbol.for("qurl-mcp.consoleTimestampPatched");

function formatTimestamp(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  const milliseconds = String(date.getMilliseconds()).padStart(3, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${milliseconds}`;
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
