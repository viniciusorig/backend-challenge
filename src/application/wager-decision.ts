import type { EventContext } from "../domain/events/integration-event";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../domain/events/wagering-events";
import { OutboxMessage, backoffDelayMs } from "../domain/messaging/outbox-message";
import { FailureCode } from "../domain/wagering/failure-code";
import {
  type WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../domain/wagering/wager-transaction";
import { LedgerDirection } from "../domain/wallet/ledger-direction";
import type { Wallet } from "../domain/wallet/wallet";
import type { WalletLedgerEntry } from "../domain/wallet/wallet-ledger-entry";
import { newId } from "../shared/ids";
import type { WageringStore } from "./ports/repositories";

export interface ReferenceRetryPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
  /** Resolution attempts made by the worker before giving up with REFERENCE_NOT_FOUND. */
  maxAttempts: number;
}

export interface DecisionContext {
  store: WageringStore;
  now: Date;
  events: EventContext;
  /** How the transaction row is written: brand new, or guarded update from its current status. */
  persist: "insert" | { expectedStatus: WagerTransactionStatus };
  /** Whether a still-missing reference counts as a failed resolution attempt (worker: yes, replay: no). */
  countAttempt: boolean;
}

export interface DecisionResult {
  entry?: WalletLedgerEntry;
  /** false when nothing changed (replay-triggered resolution that still has to wait). */
  changed: boolean;
}

/**
 * Applies one wager transaction to its wallet. MUST be called with the wallet
 * row locked (SELECT ... FOR UPDATE) inside the caller's SQL transaction: the
 * reference lookup, the balance check and the writes below are then atomic
 * with respect to every other writer of the same wallet.
 *
 * Writes (all in the caller's transaction): the transaction row, the wallet
 * balance (version-guarded), the ledger line and the outbox events.
 */
export class WagerDecisionService {
  constructor(private readonly retryPolicy: ReferenceRetryPolicy) {}

  async decide(tx: WagerTransaction, wallet: Wallet, ctx: DecisionContext): Promise<DecisionResult> {
    if (tx.playerId !== wallet.playerId) {
      return this.reject(tx, wallet, FailureCode.PlayerWalletMismatch, ctx);
    }
    if (!tx.money.hasCurrency(wallet.currency)) {
      return this.reject(tx, wallet, FailureCode.CurrencyMismatch, ctx);
    }

    let reference: WagerTransaction | undefined;
    if (tx.hasReference()) {
      reference = await ctx.store.transactions.findByExternalId(tx.providerId, tx.referenceExternalTransactionId!);
      const check = reference ? tx.checkReference(reference) : ({ ok: false, wait: true } as const);
      if (!check.ok) {
        return check.wait
          ? this.waitForReference(tx, wallet, reference !== undefined, ctx)
          : this.reject(tx, wallet, check.code, ctx);
      }
      if (tx.isReversal() && (await ctx.store.transactions.hasProcessedReversalOf(reference!.id))) {
        return this.reject(tx, wallet, FailureCode.ReferenceAlreadyReversed, ctx);
      }
    }

    if (!tx.affectsBalance()) {
      tx.markProcessed(reference?.id, ctx.now, wallet.balance);
      await this.persistTransaction(tx, ctx);
      await this.emit(ctx, WagerTransactionProcessed.from(tx, ctx.events));
      await this.wakeDependents(tx, ctx);
      return { changed: true };
    }

    const direction = tx.ledgerDirectionFor(reference);
    if (direction === LedgerDirection.Debit && !wallet.canDebit(tx.money)) {
      const code = tx.kind === WagerTransactionKind.Bet ? FailureCode.InsufficientFunds : FailureCode.ReversalInsufficientFunds;
      return this.reject(tx, wallet, code, ctx);
    }

    const expectedVersion = wallet.version;
    const entry = wallet.move(direction, { entryId: newId(), transactionId: tx.id, money: tx.money, at: ctx.now });
    tx.markProcessed(reference?.id, ctx.now, wallet.balance);

    await this.persistTransaction(tx, ctx);
    await ctx.store.wallets.saveBalance(wallet, expectedVersion);
    await ctx.store.ledger.insert(entry);
    await this.emit(ctx, WagerTransactionProcessed.from(tx, ctx.events));
    await this.emit(ctx, WalletBalanceChanged.from(wallet, entry, ctx.events));
    await this.wakeDependents(tx, ctx);
    return { entry, changed: true };
  }

  private async waitForReference(
    tx: WagerTransaction,
    wallet: Wallet,
    referenceExists: boolean,
    ctx: DecisionContext,
  ): Promise<DecisionResult> {
    if (tx.status === WagerTransactionStatus.Pending) {
      tx.markPendingReference(this.nextAttemptAt(ctx.now, 1), wallet.balance);
      await this.persistTransaction(tx, ctx);
      await this.emit(ctx, WagerTransactionPendingReference.from(tx, ctx.events));
      return { changed: true };
    }
    if (!ctx.countAttempt) {
      return { changed: false };
    }
    if (tx.referenceAttempts + 1 >= this.retryPolicy.maxAttempts) {
      // A reference that exists but never settled is reported differently from one that never arrived.
      const code = referenceExists ? FailureCode.ReferenceNotProcessed : FailureCode.ReferenceNotFound;
      return this.reject(tx, wallet, code, ctx);
    }
    tx.scheduleReferenceRetry(this.nextAttemptAt(ctx.now, tx.referenceAttempts + 2));
    await this.persistTransaction(tx, ctx);
    return { changed: true };
  }

  private async reject(
    tx: WagerTransaction,
    wallet: Wallet,
    code: FailureCode,
    ctx: DecisionContext,
  ): Promise<DecisionResult> {
    tx.reject(code, ctx.now, wallet.balance);
    await this.persistTransaction(tx, ctx);
    await this.emit(ctx, WagerTransactionRejected.from(tx, ctx.events));
    await this.wakeDependents(tx, ctx);
    return { changed: true };
  }

  private nextAttemptAt(now: Date, attempt: number): Date {
    return new Date(now.getTime() + backoffDelayMs(attempt, this.retryPolicy));
  }

  private async persistTransaction(tx: WagerTransaction, ctx: DecisionContext): Promise<void> {
    if (ctx.persist === "insert") {
      await ctx.store.transactions.insert(tx);
    } else {
      await ctx.store.transactions.update(tx, ctx.persist.expectedStatus);
    }
  }

  /** Dependents waiting on this transaction get re-evaluated now instead of at their backoff time. */
  private async wakeDependents(tx: WagerTransaction, ctx: DecisionContext): Promise<void> {
    await ctx.store.transactions.wakeDependents(tx.providerId, tx.externalTransactionId, ctx.now);
  }

  private async emit(ctx: DecisionContext, event: Parameters<typeof OutboxMessage.enqueue>[0]): Promise<void> {
    await ctx.store.outbox.add(OutboxMessage.enqueue(event));
  }
}
