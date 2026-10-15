import type { MoneyProps } from "../money/money";
import type { FailureCode } from "../wagering/failure-code";
import type { WagerTransaction } from "../wagering/wager-transaction";
import type { LedgerDirection } from "../wallet/ledger-direction";
import type { Wallet } from "../wallet/wallet";
import type { WalletLedgerEntry } from "../wallet/wallet-ledger-entry";
import { type EventContext, IntegrationEvent } from "./integration-event";

interface TransactionRef {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
}

function transactionRef(tx: WagerTransaction): TransactionRef {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
  };
}

function envelope(aggregateId: string, ctx: EventContext) {
  return {
    eventId: ctx.newEventId(),
    aggregateId,
    correlationId: ctx.correlationId,
    causationId: ctx.causationId,
    occurredAt: ctx.occurredAt,
  };
}

// ---------------------------------------------------------------------------

export interface WagerTransactionProcessedData extends TransactionRef {
  referenceTransactionId?: string;
  balance: MoneyProps;
  processedAt: string;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed({
      ...envelope(tx.walletId, ctx),
      data: {
        ...transactionRef(tx),
        ...(tx.referenceTransactionId ? { referenceTransactionId: tx.referenceTransactionId } : {}),
        balance: tx.observedBalance!.toJSON(),
        processedAt: tx.processedAt!.toISOString(),
      },
    });
  }
}

// ---------------------------------------------------------------------------

export interface WagerTransactionRejectedData extends TransactionRef {
  failureCode: FailureCode;
  rejectedAt: string;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected({
      ...envelope(tx.walletId, ctx),
      data: { ...transactionRef(tx), failureCode: tx.failureCode!, rejectedAt: tx.processedAt!.toISOString() },
    });
  }
}

// ---------------------------------------------------------------------------

export interface WagerTransactionPendingReferenceData extends TransactionRef {
  referenceExternalTransactionId: string;
  attempts: number;
  nextAttemptAt: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({
      ...envelope(tx.walletId, ctx),
      data: {
        ...transactionRef(tx),
        referenceExternalTransactionId: tx.referenceExternalTransactionId!,
        attempts: tx.referenceAttempts,
        nextAttemptAt: tx.nextReferenceAttemptAt!.toISOString(),
      },
    });
  }
}

// ---------------------------------------------------------------------------

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = "WalletBalanceChanged";
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged({
      ...envelope(wallet.id, ctx),
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: entry.walletVersion,
      },
    });
  }
}
