import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { OpenWallet } from "../../application/use-cases/open-wallet";
import { WageringQueries } from "../../application/use-cases/queries";
import { ReconcileWallet } from "../../application/use-cases/reconcile-wallet";
import { openWalletSchema } from "../contracts";
import { Roles } from "./auth";
import { presentLedgerEntry, presentReconciliation, presentWallet } from "./presenters";

const walletIdParam = z.string().uuid();
const ledgerQuery = z.object({
  cursor: z.string().max(256).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

type CorrelatedRequest = Request & { correlationId: string };

@Controller("wallets")
export class WalletsController {
  constructor(
    @Inject(OpenWallet) private readonly openWallet: OpenWallet,
    @Inject(WageringQueries) private readonly queries: WageringQueries,
    @Inject(ReconcileWallet) private readonly reconcile: ReconcileWallet,
  ) {}

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown, @Req() req: CorrelatedRequest) {
    const cmd = openWalletSchema.parse(body);
    const wallet = await this.openWallet.execute(cmd, req.correlationId);
    const { id, playerId, balance, version } = presentWallet(wallet);
    return { id, playerId, balance, version };
  }

  @Get(":walletId")
  async get(@Param("walletId") walletId: string) {
    return presentWallet(await this.queries.wallet(walletIdParam.parse(walletId)));
  }

  @Get(":walletId/ledger")
  async ledger(@Param("walletId") walletId: string, @Query() query: unknown) {
    const { cursor, limit } = ledgerQuery.parse(query);
    const page = await this.queries.ledger(walletIdParam.parse(walletId), cursor, limit);
    return { items: page.entries.map(presentLedgerEntry), nextCursor: page.nextCursor ?? null };
  }

  /** Back-office operation: requires the operator role. */
  @Post(":walletId/reconciliation")
  @HttpCode(200)
  @Roles("operator")
  async reconciliation(@Param("walletId") walletId: string) {
    return presentReconciliation(await this.reconcile.execute(walletIdParam.parse(walletId)));
  }
}
