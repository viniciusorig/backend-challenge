import { Body, Controller, ForbiddenException, Get, Headers, Inject, Param, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { z } from "zod";
import { InvalidRequestError } from "../../application/errors";
import { WageringQueries } from "../../application/use-cases/queries";
import { SubmitWagerTransaction } from "../../application/use-cases/submit-wager-transaction";
import { WagerTransactionStatus } from "../../domain/wagering/wager-transaction";
import { enrichLogContext, logger } from "../../infrastructure/observability/logger";
import { wagerRequestSchema } from "../contracts";
import { type ProviderPrincipal, principalCanActFor, principalCanRead } from "./auth";
import { APP_CONFIG, type AppConfig } from "../../shared/config";
import { presentSubmission, presentTransaction } from "./presenters";

const idempotencyKeySchema = z.string().trim().min(1).max(255);

/** Business outcome → HTTP status. Errors are mapped by ErrorFilter. */
function statusFor(status: WagerTransactionStatus, replay: boolean): number {
  switch (status) {
    case WagerTransactionStatus.Processed:
      return replay ? 200 : 201;
    case WagerTransactionStatus.PendingReference:
    case WagerTransactionStatus.Pending:
      return 202; // accepted, processing pending
    case WagerTransactionStatus.Rejected:
      return 422; // business rule rejection (see failureCode)
    case WagerTransactionStatus.Failed:
      return 500;
  }
}

type AppRequest = Request & { correlationId: string; principal?: ProviderPrincipal };

@Controller()
export class WageringController {
  constructor(
    @Inject(SubmitWagerTransaction) private readonly submit: SubmitWagerTransaction,
    @Inject(WageringQueries) private readonly queries: WageringQueries,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post("wagering/transactions")
  async create(
    @Headers("idempotency-key") idempotencyKeyHeader: string | undefined,
    @Body() body: unknown,
    @Req() req: AppRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const key = idempotencyKeySchema.safeParse(idempotencyKeyHeader);
    if (!key.success) throw new InvalidRequestError("Idempotency-Key header is required (1..255 chars)");
    const request = wagerRequestSchema.parse(body);
    if (!principalCanActFor(req.principal, request.providerId)) {
      throw new ForbiddenException({ code: "FORBIDDEN", message: `Not allowed to act for provider ${request.providerId}` });
    }
    enrichLogContext({ providerId: request.providerId, walletId: request.walletId });

    const result = await this.submit.execute(
      { ...request, idempotencyKey: key.data },
      { source: "http", correlationId: req.correlationId, causationId: key.data },
    );
    const tx = result.transaction;
    enrichLogContext({ transactionId: tx.id });
    logger.info("wager transaction submitted", {
      status: tx.status,
      kind: tx.kind,
      failureCode: tx.failureCode,
      idempotentReplay: result.idempotentReplay,
    });
    res.status(statusFor(tx.status, result.idempotentReplay));
    return presentSubmission(tx, result.idempotentReplay);
  }

  @Get("wagering/transactions/:transactionId")
  async get(@Param("transactionId") transactionId: string, @Req() req: AppRequest) {
    const tx = await this.queries.transaction(z.string().uuid().parse(transactionId));
    this.assertCanRead(req.principal, tx.providerId);
    return presentTransaction(tx);
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  async getByExternalId(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
    @Req() req: AppRequest,
  ) {
    this.assertCanRead(req.principal, providerId);
    return presentTransaction(await this.queries.transactionByExternalId(providerId, externalTransactionId));
  }

  /** A provider only sees its own transactions; operators see everything. */
  private assertCanRead(principal: ProviderPrincipal | undefined, providerId: string): void {
    if (!principalCanRead(principal, providerId, this.config.auth.operatorRole)) {
      throw new ForbiddenException({ code: "FORBIDDEN", message: `Not allowed to read transactions of provider ${providerId}` });
    }
  }
}
