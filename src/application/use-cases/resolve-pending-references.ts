import { WagerTransactionStatus } from "../../domain/wagering/wager-transaction";
import { newId } from "../../shared/ids";
import type { Clock } from "../ports/clock";
import type { WageringMetrics } from "../ports/metrics";
import type { UnitOfWork } from "../ports/repositories";
import { withTransientRetry } from "../transient-retry";
import type { WagerDecisionService } from "../wager-decision";

export interface ResolutionReport {
  examined: number;
  resolved: number;
  rescheduled: number;
}

/**
 * Re-evaluates PENDING_REFERENCE transactions whose backoff expired.
 *
 * Candidates are read without locks; each one is then handled in its own SQL
 * transaction that locks the *wallet first* (same lock order as the submit
 * path, so no deadlock between the two) and re-reads the transaction. If two
 * instances pick the same candidate, the second one sees it is no longer due
 * and skips it.
 */
export class ResolvePendingReferences {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly decisions: WagerDecisionService,
    private readonly clock: Clock,
    private readonly metrics: WageringMetrics,
    private readonly retryAttempts: number,
  ) {}

  async runOnce(limit: number): Promise<ResolutionReport> {
    const due = await this.uow.read((store) => store.transactions.findDuePendingReferences(this.clock.now(), limit));
    const report: ResolutionReport = { examined: due.length, resolved: 0, rescheduled: 0 };

    for (const candidate of due) {
      const startedAt = performance.now();
      const outcome = await withTransientRetry("resolve_pending_reference", this.retryAttempts, this.metrics, () =>
        this.uow.transactional(async (store) => {
          const now = this.clock.now();
          const wallet = await store.wallets.lockForUpdate(candidate.walletId);
          const tx = await store.transactions.lockById(candidate.id);
          if (!wallet || !tx || tx.status !== WagerTransactionStatus.PendingReference) return undefined;
          if (tx.nextReferenceAttemptAt && tx.nextReferenceAttemptAt > now) return undefined;
          await this.decisions.decide(tx, wallet, {
            store,
            now,
            events: { correlationId: tx.correlationId, causationId: tx.id, occurredAt: now, newEventId: newId },
            persist: { expectedStatus: WagerTransactionStatus.PendingReference },
            countAttempt: true,
          });
          return tx;
        }),
      );
      if (!outcome) continue;
      if (outcome.isTerminal()) {
        report.resolved++;
        this.metrics.transactionFinished(outcome.kind, outcome.status, "worker", (performance.now() - startedAt) / 1000);
      } else {
        report.rescheduled++;
        this.metrics.retry("pending_reference", "REFERENCE_MISSING");
      }
    }
    return report;
  }
}
