import { Money } from "../../domain/money/money";
import { WalletNotFoundError } from "../errors";
import type { WageringMetrics } from "../ports/metrics";
import type { UnitOfWork } from "../ports/repositories";

export interface ReconciliationReport {
  walletId: string;
  storedBalance: Money;
  calculatedBalance: Money;
  difference: Money;
  consistent: boolean;
  checkedEntries: number;
}

export interface ReconciliationAlert {
  (report: ReconciliationReport): void;
}

/**
 * Recomputes the balance from the ledger (Σ credits − Σ debits) and compares
 * it with the materialized balance. Runs under FOR SHARE on the wallet so no
 * writer can slip a line in between the two reads. Divergences are reported
 * (log + metric + response) and never auto-corrected.
 */
export class ReconcileWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly metrics: WageringMetrics,
    private readonly onDivergence: ReconciliationAlert,
  ) {}

  async execute(walletId: string): Promise<ReconciliationReport> {
    const report = await this.uow.transactional(async (store) => {
      const wallet = await store.wallets.lockForShare(walletId);
      if (!wallet) throw new WalletNotFoundError(walletId);
      const totals = await store.ledger.totals(walletId, wallet.currency);
      const calculated = Money.fromSigned({ amount: totals.credits, currency: wallet.currency }).subtract(
        Money.fromSigned({ amount: totals.debits, currency: wallet.currency }),
      );
      const difference = wallet.balance.subtract(calculated);
      return {
        walletId,
        storedBalance: wallet.balance,
        calculatedBalance: calculated,
        difference,
        consistent: difference.isZero(),
        checkedEntries: totals.count,
      };
    });
    this.metrics.reconciliationChecked(report.consistent);
    if (!report.consistent) this.onDivergence(report);
    return report;
  }
}
