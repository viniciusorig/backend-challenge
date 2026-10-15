import {
  ConnectionException,
  DeadlockException,
  LockWaitTimeoutException,
  UniqueConstraintViolationException,
} from "@mikro-orm/core";
import { TransientInfrastructureError, UniqueViolationError } from "../../application/errors";

const TRANSIENT_SQLSTATES = new Set([
  "40001", // serialization_failure
  "40P01", // deadlock_detected
  "55P03", // lock_not_available (lock_timeout)
  "57014", // query_canceled (statement_timeout)
  "53300", // too_many_connections
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
]);
const CONNECTION_ERRNOS = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN"]);

function field(error: unknown, name: string): string | undefined {
  let current: unknown = error;
  for (let depth = 0; current && depth < 4; depth++) {
    const value = (current as Record<string, unknown>)[name];
    if (typeof value === "string") return value;
    current = (current as { cause?: unknown; previous?: unknown }).cause ?? (current as { previous?: unknown }).previous;
  }
  return undefined;
}

/**
 * Translates driver / ORM errors into the application's vocabulary so the
 * application layer never imports ORM types. Unknown errors pass through.
 */
export function translateDbError(error: unknown): unknown {
  if (error instanceof TransientInfrastructureError || error instanceof UniqueViolationError) return error;
  const sqlState = field(error, "sqlState") ?? field(error, "code");
  const message = error instanceof Error ? error.message : String(error);

  if (error instanceof UniqueConstraintViolationException || sqlState === "23505") {
    const constraint = field(error, "constraint") ?? /unique constraint "([^"]+)"/.exec(message)?.[1];
    return new UniqueViolationError(constraint, { cause: error });
  }
  if (error instanceof LockWaitTimeoutException || sqlState === "55P03") {
    return new TransientInfrastructureError("LOCK_TIMEOUT", "Timed out waiting for a row lock", { cause: error });
  }
  if (error instanceof DeadlockException || (sqlState && TRANSIENT_SQLSTATES.has(sqlState))) {
    return new TransientInfrastructureError("CONCURRENCY_CONFLICT", `Transient database conflict (${sqlState})`, {
      cause: error,
    });
  }
  if (
    error instanceof ConnectionException ||
    (sqlState && (sqlState.startsWith("08") || CONNECTION_ERRNOS.has(sqlState))) ||
    /Connection terminated|connect ECONNREFUSED|timeout exceeded when trying to connect|Knex: Timeout acquiring a connection/i.test(
      message,
    )
  ) {
    return new TransientInfrastructureError("DATABASE_UNAVAILABLE", "Database unavailable", { cause: error });
  }
  return error;
}
