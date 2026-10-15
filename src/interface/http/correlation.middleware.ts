import type { NextFunction, Request, Response } from "express";
import { withLogContext } from "../../infrastructure/observability/logger";
import { newId } from "../../shared/ids";

const SAFE = /^[A-Za-z0-9._:-]{1,128}$/;

/** Reads or creates X-Correlation-Id and binds it to the async log context of the request. */
export function correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header("x-correlation-id");
  const correlationId = incoming && SAFE.test(incoming) ? incoming : newId();
  res.setHeader("x-correlation-id", correlationId);
  (req as Request & { correlationId: string }).correlationId = correlationId;
  withLogContext({ correlationId }, () => next());
}
