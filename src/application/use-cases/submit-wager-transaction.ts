import type { EventContext } from "../../domain/events/integration-event";
import { InboxMessage } from "../../domain/messaging/inbox-message";
import { WagerTransaction, WagerTransactionStatus } from "../../domain/wagering/wager-transaction";
import { newId } from "../../shared/ids";
import { type SubmitWagerCommand, type ValidatedWagerCommand, validateWagerCommand } from "../commands";
import { IdempotencyConflictError, TransactionNotFoundError, WalletNotFoundError } from "../errors";
import type { Clock } from "../ports/clock";
import type { RequestSource, WageringMetrics } from "../ports/metrics";
import type { UnitOfWork, WageringStore } from "../ports/repositories";
import { withTransientRetry } from "../transient-retry";
import type { WagerDecisionService } from "../wager-decision";

export interface InboxContext {
  consumerName: string;
  messageId: string;
  payloadHash: string;
}

export interface SubmitOptions {
  source: RequestSource;
  correlationId: string;
  causationId?: string;
  /** Present when the request came from the queue: dedup by (consumerName, messageId) in the same SQL transaction. */
  inbox?: InboxContext;
}

export interface SubmitResult {
  transaction: WagerTransaction;
  /** true when the idempotency key (or the message id) had already been processed. */
  idempotentReplay: boolean;
  /** true when the SQS message itself was a redelivery already recorded in the inbox. */
  duplicateMessage: boolean;
}

/**
 * Single entry point for provider operations, shared by HTTP and SQS.
 *
 * Inside ONE SQL transaction: inbox claim → idempotency lookup → wallet row
 * lock → re-check under lock → decide (balance, ledger, outbox) → inbox done.
 */
export class SubmitWagerTransaction {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly decisions: WagerDecisionService,
    private readonly clock: Clock,
    private readonly metrics: WageringMetrics,
    private readonly retryAttempts: number,
  ) {}

  async execute(raw: SubmitWagerCommand, options: SubmitOptions): Promise<SubmitResult> {
    const cmd = validateWagerCommand(raw);
    const startedAt = performance.now();
    const result = await withTransientRetry("submit_wager_transaction", this.retryAttempts, this.metrics, () =>
      this.uow.transactional((store) => this.attempt(cmd, options, store)),
    );
    if (result.idempotentReplay) {
      this.metrics.duplicateDetected(result.duplicateMessage ? "inbox_message" : "idempotency_replay", options.source);
    }
    this.metrics.transactionFinished(
      result.transaction.kind,
      result.transaction.status,
      options.source,
      (performance.now() - startedAt) / 1000,
    );
    return result;
  }

  private async attempt(cmd: ValidatedWagerCommand, options: SubmitOptions, store: WageringStore): Promise<SubmitResult> {
    const now = this.clock.now();

    let inboxMessage: InboxMessage | undefined;
    if (options.inbox) {
      inboxMessage = InboxMessage.receive({ ...options.inbox, receivedAt: now });
      const claimed = await store.inbox.tryReceive(inboxMessage);
      if (!claimed) return this.duplicateMessage(cmd, options.inbox, store);
    }

    // Fast path without locks: plain replays never touch the wallet row.
    const known = await this.findExisting(cmd, store);
    if (known && known.status !== WagerTransactionStatus.PendingReference) {
      return this.finish(store, inboxMessage, known, true);
    }

    const wallet = await store.wallets.lockForUpdate(cmd.walletId);
    if (!wallet) throw new WalletNotFoundError(cmd.walletId);

    const ctx = {
      store,
      now,
      events: this.eventContext(options, now),
    };

    // Re-check under the wallet lock: a concurrent duplicate may have committed while we waited.
    const existing = await this.findExisting(cmd, store);
    if (existing) {
      if (existing.status === WagerTransactionStatus.PendingReference) {
        // A resubmission is a good moment to try resolving the reference again.
        const locked = (await store.transactions.lockById(existing.id))!;
        if (locked.status === WagerTransactionStatus.PendingReference) {
          await this.decisions.decide(locked, wallet, {
            ...ctx,
            persist: { expectedStatus: WagerTransactionStatus.PendingReference },
            countAttempt: false,
          });
        }
        return this.finish(store, inboxMessage, locked, true);
      }
      return this.finish(store, inboxMessage, existing, true);
    }

    const tx = WagerTransaction.create({
      id: newId(),
      providerId: cmd.providerId,
      externalTransactionId: cmd.externalTransactionId,
      idempotencyKey: cmd.idempotencyKey,
      payloadHash: cmd.payloadHash,
      walletId: cmd.walletId,
      playerId: cmd.playerId,
      roundId: cmd.roundId,
      gameId: cmd.gameId,
      kind: cmd.kind,
      money: cmd.money,
      referenceExternalTransactionId: cmd.referenceExternalTransactionId,
      correlationId: options.correlationId,
      createdAt: now,
    });
    await this.decisions.decide(tx, wallet, { ...ctx, persist: "insert", countAttempt: false });
    return this.finish(store, inboxMessage, tx, false);
  }

  /**
   * Looks up a previous submission. Same key + same payload → replay;
   * same key + different payload, or same provider external id under a
   * different key → conflict (never a replay).
   */
  private async findExisting(cmd: ValidatedWagerCommand, store: WageringStore): Promise<WagerTransaction | undefined> {
    const byKey = await store.transactions.findByIdempotencyKey(cmd.idempotencyKey);
    if (byKey) return this.assertSamePayload(byKey, cmd);

    const byExternalId = await store.transactions.findByExternalId(cmd.providerId, cmd.externalTransactionId);
    if (!byExternalId) return undefined;
    // Under READ COMMITTED each statement sees a fresh snapshot: a concurrent duplicate may have
    // committed between the two lookups. Same key → it is our own replay, not a conflict.
    if (byExternalId.idempotencyKey === cmd.idempotencyKey) return this.assertSamePayload(byExternalId, cmd);
    throw new IdempotencyConflictError(
      "EXTERNAL_TRANSACTION_ID_CONFLICT",
      "externalTransactionId was already submitted under a different Idempotency-Key",
      byExternalId.id,
    );
  }

  private assertSamePayload(existing: WagerTransaction, cmd: ValidatedWagerCommand): WagerTransaction {
    if (!existing.matchesPayload(cmd.payloadHash)) {
      throw new IdempotencyConflictError(
        "IDEMPOTENCY_KEY_CONFLICT",
        "Idempotency-Key was already used with a different payload",
        existing.id,
      );
    }
    return existing;
  }

  private async duplicateMessage(
    cmd: ValidatedWagerCommand,
    inbox: InboxContext,
    store: WageringStore,
  ): Promise<SubmitResult> {
    const recorded = await store.inbox.find(inbox.consumerName, inbox.messageId);
    if (recorded && recorded.message.payloadHash !== inbox.payloadHash) {
      throw new IdempotencyConflictError(
        "INBOX_MESSAGE_CONFLICT",
        `Message ${inbox.messageId} was already consumed with a different payload`,
      );
    }
    const tx = recorded?.transactionId
      ? await store.transactions.findById(recorded.transactionId)
      : await store.transactions.findByIdempotencyKey(cmd.idempotencyKey);
    if (!tx) throw new TransactionNotFoundError(`for message ${inbox.messageId}`);
    return { transaction: tx, idempotentReplay: true, duplicateMessage: true };
  }

  private async finish(
    store: WageringStore,
    inbox: InboxMessage | undefined,
    tx: WagerTransaction,
    idempotentReplay: boolean,
  ): Promise<SubmitResult> {
    if (inbox) {
      inbox.markProcessed(this.clock.now());
      await store.inbox.markProcessed(inbox, tx.id);
    }
    return { transaction: tx, idempotentReplay, duplicateMessage: false };
  }

  private eventContext(options: SubmitOptions, now: Date): EventContext {
    return {
      correlationId: options.correlationId,
      causationId: options.causationId,
      occurredAt: now,
      newEventId: newId,
    };
  }
}
