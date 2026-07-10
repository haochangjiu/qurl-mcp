import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestAuthContext {
  qurlApiKey?: string;
  qurlConnectorUrl?: string;
  maxUploadFileDataBytes?: number;
  sessionId?: string;
}

const requestAuthStorage = new AsyncLocalStorage<RequestAuthContext>();

export function runWithRequestAuthContext<T>(
  context: RequestAuthContext,
  fn: () => Promise<T>,
): Promise<T> {
  return requestAuthStorage.run(context, fn);
}

export function getRequestQurlApiKey(): string | undefined {
  const apiKey = requestAuthStorage.getStore()?.qurlApiKey?.trim();
  return apiKey ? apiKey : undefined;
}

export function getRequestQurlConnectorUrl(): string | undefined {
  const connectorUrl = requestAuthStorage.getStore()?.qurlConnectorUrl?.trim();
  return connectorUrl ? connectorUrl : undefined;
}

export function getRequestMaxUploadFileDataBytes(): number | undefined {
  const value = requestAuthStorage.getStore()?.maxUploadFileDataBytes;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function getRequestSessionId(): string | undefined {
  const sessionId = requestAuthStorage.getStore()?.sessionId?.trim();
  return sessionId ? sessionId : undefined;
}
