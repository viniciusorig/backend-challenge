import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus } from "@nestjs/common";
import type { Response } from "express";
import { logger } from "../../infrastructure/observability/logger";
import { type ErrorKind, classifyError } from "../error-classification";

/**
 * One mapping for every endpoint:
 *
 *   400 VALIDATION_ERROR ............ payload / params invalid (do not resend as is)
 *   401 UNAUTHORIZED ................ missing / invalid / expired bearer token (WWW-Authenticate: Bearer)
 *   403 FORBIDDEN ................... token valid but not allowed for this provider / role
 *   404 *_NOT_FOUND ................. unknown wallet / transaction
 *   409 *_CONFLICT / *_EXISTS ....... idempotency or uniqueness conflict (never a replay)
 *   503 DATABASE_UNAVAILABLE, LOCK_TIMEOUT, ... transient: safe to resend with the same key (Retry-After)
 *   500 INTERNAL_ERROR .............. bug; safe to resend with the same key
 *
 * Business outcomes are NOT errors: a submitted transaction answers 201/200
 * (PROCESSED), 202 (PENDING_REFERENCE) or 422 (REJECTED + failureCode).
 */
const STATUS: Record<ErrorKind, number> = {
  validation: HttpStatus.BAD_REQUEST,
  not_found: HttpStatus.NOT_FOUND,
  conflict: HttpStatus.CONFLICT,
  transient: HttpStatus.SERVICE_UNAVAILABLE,
  internal: HttpStatus.INTERNAL_SERVER_ERROR,
};

@Catch()
export class ErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const correlationId = response.getHeader("x-correlation-id");

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      const explicit = typeof payload === "object" && payload !== null ? (payload as { code?: unknown; message?: unknown }) : {};
      const fallback =
        status === 400 ? "VALIDATION_ERROR" : status === 401 ? "UNAUTHORIZED" : status === 403 ? "FORBIDDEN" : status === 404 ? "ROUTE_NOT_FOUND" : "HTTP_ERROR";
      const code = typeof explicit.code === "string" ? explicit.code : fallback;
      const message = typeof explicit.message === "string" ? explicit.message : exception.message;
      if (status === 401) response.setHeader("WWW-Authenticate", 'Bearer realm="wagering"');
      response
        .status(status)
        .json({ error: { code, message, retryable: status === 503, correlationId } });
      return;
    }

    const classified = classifyError(exception);
    const status = STATUS[classified.kind];
    if (classified.kind === "internal") {
      logger.error("unhandled error", { error: exception });
    } else if (classified.kind === "transient") {
      logger.warn("transient failure", { error: exception, code: classified.code });
      response.setHeader("Retry-After", "1");
    }
    response.status(status).json({
      error: {
        code: classified.code,
        message: classified.message,
        retryable: classified.kind === "transient" || classified.kind === "internal",
        ...(classified.details ? { details: classified.details } : {}),
        correlationId,
      },
    });
  }
}
