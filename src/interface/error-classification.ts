import { ZodError } from "zod";
import { ApplicationError, TransientInfrastructureError } from "../application/errors";
import { DomainError, InvalidArgumentError } from "../domain/errors";

export type ErrorKind = "validation" | "not_found" | "conflict" | "transient" | "internal";

export interface ClassifiedError {
  kind: ErrorKind;
  code: string;
  message: string;
  details?: unknown;
}

/** One classification used by both adapters (HTTP status / SQS ack-retry-DLQ). */
export function classifyError(error: unknown): ClassifiedError {
  if (error instanceof ZodError) {
    return {
      kind: "validation",
      code: "VALIDATION_ERROR",
      message: "Invalid payload",
      details: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    };
  }
  if (error instanceof SyntaxError) {
    return { kind: "validation", code: "VALIDATION_ERROR", message: "Malformed JSON" };
  }
  if (error instanceof InvalidArgumentError) {
    return { kind: "validation", code: error.code, message: error.message };
  }
  if (error instanceof ApplicationError) {
    const kind: ErrorKind =
      error.category === "VALIDATION"
        ? "validation"
        : error.category === "NOT_FOUND"
          ? "not_found"
          : error.category === "CONFLICT"
            ? "conflict"
            : "transient";
    const details = (error as { details?: unknown }).details;
    return { kind, code: error.code, message: error.message, ...(details ? { details } : {}) };
  }
  if (error instanceof DomainError) {
    // Any other domain error escaping to an adapter is a bug, not a client problem.
    return { kind: "internal", code: error.code, message: "Internal error" };
  }
  return { kind: "internal", code: "INTERNAL_ERROR", message: "Internal error" };
}

export function isTransient(error: unknown): error is TransientInfrastructureError {
  return error instanceof TransientInfrastructureError;
}
