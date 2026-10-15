import { AsyncLocalStorage } from "node:async_hooks";
import type { LoggerService } from "@nestjs/common";

/** Correlation fields carried implicitly through async calls of one request / message. */
export interface LogContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
  [key: string]: unknown;
}

const storage = new AsyncLocalStorage<LogContext>();

export function withLogContext<T>(context: LogContext, fn: () => T): T {
  return storage.run({ ...storage.getStore(), ...context }, fn);
}

/** Adds fields to the current context (e.g. transactionId once it is known). */
export function enrichLogContext(fields: LogContext): void {
  const store = storage.getStore();
  if (store) Object.assign(store, fields);
}

type Level = "debug" | "info" | "warn" | "error";
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Keys that must never reach the logs: amounts, balances and raw payloads are
 * financial data. Logs carry identifiers and outcomes only.
 */
const REDACTED_KEYS = new Set(["amount", "balance", "money", "payload", "body", "data", "initialBalance", "authorization"]);

function sanitize(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    out[key] = REDACTED_KEYS.has(key) ? "[redacted]" : value;
  }
  return out;
}

function serializeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { message: String(error) };
  return {
    type: error.name,
    message: error.message,
    code: (error as { code?: unknown }).code,
    stack: error.stack?.split("\n").slice(0, 6).join("\n"),
  };
}

export class JsonLogger implements LoggerService {
  private threshold: number;

  constructor(
    level: string = process.env.LOG_LEVEL ?? "info",
    private readonly base: Record<string, unknown> = {},
  ) {
    this.threshold = LEVELS[(level as Level) in LEVELS ? (level as Level) : "info"];
  }

  debug(message: unknown, ...rest: unknown[]): void {
    this.write("debug", message, rest);
  }
  log(message: unknown, ...rest: unknown[]): void {
    this.write("info", message, rest);
  }
  info(message: string, fields: Record<string, unknown> = {}): void {
    this.write("info", message, [fields]);
  }
  warn(message: unknown, ...rest: unknown[]): void {
    this.write("warn", message, rest);
  }
  error(message: unknown, ...rest: unknown[]): void {
    this.write("error", message, rest);
  }
  verbose(message: unknown, ...rest: unknown[]): void {
    this.write("debug", message, rest);
  }

  private write(level: Level, message: unknown, rest: unknown[]): void {
    if (LEVELS[level] < this.threshold) return;
    let fields: Record<string, unknown> = {};
    for (const item of rest) {
      if (item instanceof Error) fields.error = serializeError(item);
      else if (item && typeof item === "object") fields = { ...fields, ...(item as Record<string, unknown>) };
      else if (typeof item === "string") fields.context = item; // Nest passes the context name as a string
    }
    if (fields.error && !(fields.error as Record<string, unknown>).type) {
      fields.error = serializeError(fields.error);
    }
    const line = {
      level,
      time: new Date().toISOString(),
      msg: typeof message === "string" ? message : JSON.stringify(message),
      ...this.base,
      ...storage.getStore(),
      ...sanitize(fields),
    };
    const out = JSON.stringify(line);
    if (LEVELS[level] >= LEVELS.warn) process.stderr.write(`${out}\n`);
    else process.stdout.write(`${out}\n`);
  }
}

export const logger = new JsonLogger(process.env.LOG_LEVEL ?? "info", {
  service: "wagering-processor",
  instanceId: process.env.INSTANCE_ID ?? String(process.pid),
});
