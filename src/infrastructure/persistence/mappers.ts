import { InboxMessage } from "../../domain/messaging/inbox-message";
import { OutboxMessage } from "../../domain/messaging/outbox-message";
import { Money } from "../../domain/money/money";
import type { FailureCode } from "../../domain/wagering/failure-code";
import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from "../../domain/wagering/wager-transaction";
import type { LedgerDirection } from "../../domain/wallet/ledger-direction";
import { Wallet } from "../../domain/wallet/wallet";
import { WalletLedgerEntry } from "../../domain/wallet/wallet-ledger-entry";
import type {
  InboxRecord,
  LedgerEntryRecord,
  OutboxRecord,
  WagerTransactionRecord,
  WalletRecord,
} from "./schemas/records";

/** NUMERIC(20,2) comes back as a decimal string; normalize to scale 2 and parse exactly. */
export function moneyFromColumn(amount: string, currency: string): Money {
  return Money.from({ amount: normalizeDecimal(amount), currency: currency.trim() });
}

function normalizeDecimal(value: string | number): string {
  const s = String(value);
  if (!s.includes(".")) return s;
  const [int, frac = ""] = s.split(".");
  return `${int}.${frac.padEnd(2, "0").slice(0, 2)}`;
}

const opt = <T>(v: T | null | undefined): T | undefined => (v === null ? undefined : v);

export const walletMapper = {
  toDomain(r: WalletRecord): Wallet {
    return Wallet.rehydrate({
      id: r.id,
      playerId: r.playerId,
      currency: r.currency.trim(),
      balance: moneyFromColumn(r.balanceAmount, r.currency),
      version: r.version,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    });
  },
  toRecord(w: Wallet): WalletRecord {
    return {
      id: w.id,
      playerId: w.playerId,
      currency: w.currency,
      balanceAmount: w.balance.formatAmount(),
      version: w.version,
      createdAt: w.createdAt,
      updatedAt: w.updatedAt,
    };
  },
};

export const transactionMapper = {
  toDomain(r: WagerTransactionRecord): WagerTransaction {
    const currency = r.currency.trim();
    return WagerTransaction.rehydrate({
      id: r.id,
      providerId: r.providerId,
      externalTransactionId: r.externalTransactionId,
      idempotencyKey: r.idempotencyKey,
      payloadHash: r.payloadHash,
      walletId: r.walletId,
      playerId: r.playerId,
      roundId: r.roundId,
      gameId: r.gameId,
      kind: r.kind as WagerTransactionKind,
      money: moneyFromColumn(r.amount, currency),
      referenceExternalTransactionId: opt(r.referenceExternalTransactionId),
      correlationId: r.correlationId,
      createdAt: r.createdAt,
      status: r.status as WagerTransactionStatus,
      referenceTransactionId: opt(r.referenceTransactionId),
      failureCode: opt(r.failureCode) as FailureCode | undefined,
      processedAt: opt(r.processedAt),
      observedBalance:
        r.observedBalanceAmount === null || r.observedBalanceAmount === undefined
          ? undefined
          : moneyFromColumn(r.observedBalanceAmount, currency),
      referenceAttempts: r.referenceAttempts,
      nextReferenceAttemptAt: opt(r.nextReferenceAttemptAt),
    });
  },
  /** Mutable columns only (the DB trigger rejects changes to anything else). */
  toMutableColumns(tx: WagerTransaction) {
    return {
      status: tx.status,
      referenceTransactionId: tx.referenceTransactionId ?? null,
      failureCode: tx.failureCode ?? null,
      observedBalanceAmount: tx.observedBalance?.formatAmount() ?? null,
      referenceAttempts: tx.referenceAttempts,
      nextReferenceAttemptAt: tx.nextReferenceAttemptAt ?? null,
      processedAt: tx.processedAt ?? null,
    };
  },
  toRecord(tx: WagerTransaction): WagerTransactionRecord {
    return {
      id: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      idempotencyKey: tx.idempotencyKey,
      payloadHash: tx.payloadHash,
      walletId: tx.walletId,
      playerId: tx.playerId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: tx.kind,
      amount: tx.money.formatAmount(),
      currency: tx.money.currency,
      referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
      correlationId: tx.correlationId,
      createdAt: tx.createdAt,
      ...transactionMapper.toMutableColumns(tx),
    };
  },
};

export const ledgerMapper = {
  toDomain(r: LedgerEntryRecord): WalletLedgerEntry {
    const currency = r.currency.trim();
    return WalletLedgerEntry.rehydrate({
      id: r.id,
      walletId: r.walletId,
      transactionId: r.transactionId,
      direction: r.direction as LedgerDirection,
      money: moneyFromColumn(r.amount, currency),
      balanceBefore: moneyFromColumn(r.balanceBefore, currency),
      balanceAfter: moneyFromColumn(r.balanceAfter, currency),
      walletVersion: r.walletVersion,
      createdAt: r.createdAt,
    });
  },
  toRecord(e: WalletLedgerEntry): LedgerEntryRecord {
    return {
      id: e.id,
      walletId: e.walletId,
      transactionId: e.transactionId,
      direction: e.direction,
      amount: e.money.formatAmount(),
      currency: e.money.currency,
      balanceBefore: e.balanceBefore.formatAmount(),
      balanceAfter: e.balanceAfter.formatAmount(),
      walletVersion: e.walletVersion,
      createdAt: e.createdAt,
    };
  },
};

export const inboxMapper = {
  toDomain(r: InboxRecord): InboxMessage {
    return InboxMessage.rehydrate({
      messageId: r.messageId,
      consumerName: r.consumerName,
      payloadHash: r.payloadHash,
      receivedAt: r.receivedAt,
      processedAt: opt(r.processedAt),
    });
  },
};

export const outboxMapper = {
  toDomain(r: OutboxRecord): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: r.id,
      aggregateId: r.aggregateId,
      eventType: r.eventType,
      payload: r.payload,
      occurredAt: r.occurredAt,
      attempts: r.attempts,
      nextAttemptAt: opt(r.nextAttemptAt),
      publishedAt: opt(r.publishedAt),
    });
  },
  toRecord(m: OutboxMessage): OutboxRecord {
    return {
      id: m.id,
      aggregateId: m.aggregateId,
      eventType: m.eventType,
      payload: m.payload as Record<string, unknown>,
      occurredAt: m.occurredAt,
      attempts: m.attempts,
      nextAttemptAt: m.nextAttemptAt ?? m.occurredAt,
      lockedUntil: null,
      lockedBy: null,
      publishedAt: m.publishedAt ?? null,
      lastError: null,
    };
  },
};
