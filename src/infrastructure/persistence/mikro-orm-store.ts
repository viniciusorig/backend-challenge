import { LockMode, type EntityManager } from "@mikro-orm/postgresql";
import { TransientInfrastructureError } from "../../application/errors";
import type {
  DuePendingReference,
  InboxRepository,
  LedgerRepository,
  LedgerTotals,
  OutboxRepository,
  WagerTransactionRepository,
  WageringStore,
  WalletRepository,
} from "../../application/ports/repositories";
import type { InboxMessage } from "../../domain/messaging/inbox-message";
import type { OutboxMessage } from "../../domain/messaging/outbox-message";
import {
  type WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/wagering/wager-transaction";
import type { Wallet } from "../../domain/wallet/wallet";
import type { WalletLedgerEntry } from "../../domain/wallet/wallet-ledger-entry";
import { inboxMapper, ledgerMapper, outboxMapper, transactionMapper, walletMapper } from "./mappers";
import {
  InboxRecord,
  LedgerEntryRecord,
  OutboxRecord,
  WagerTransactionRecord,
  WalletRecord,
} from "./schemas/records";

/*
 * Repositories over one forked EntityManager (one per unit of work).
 *
 * - Inserts go through the Unit of Work (`em.create` → flushed at commit).
 * - Guarded updates (version / status) are native `UPDATE ... WHERE guard`
 *   so the database, not the identity map, decides whether the write wins.
 * - Reads that must observe the latest committed row use `refresh: true` so
 *   the identity map never serves a stale copy inside a transaction.
 */

class MikroWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<Wallet | undefined> {
    const r = await this.em.findOne(WalletRecord, { id }, { refresh: true });
    return r ? walletMapper.toDomain(r) : undefined;
  }

  async lockForUpdate(id: string): Promise<Wallet | undefined> {
    const r = await this.em.findOne(WalletRecord, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true });
    return r ? walletMapper.toDomain(r) : undefined;
  }

  async lockForShare(id: string): Promise<Wallet | undefined> {
    const r = await this.em.findOne(WalletRecord, { id }, { lockMode: LockMode.PESSIMISTIC_READ, refresh: true });
    return r ? walletMapper.toDomain(r) : undefined;
  }

  async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined> {
    const r = await this.em.findOne(WalletRecord, { playerId, currency }, { refresh: true });
    return r ? walletMapper.toDomain(r) : undefined;
  }

  async insert(wallet: Wallet): Promise<void> {
    this.em.create(WalletRecord, walletMapper.toRecord(wallet));
  }

  async saveBalance(wallet: Wallet, expectedVersion: number): Promise<void> {
    const affected = await this.em.nativeUpdate(
      WalletRecord,
      { id: wallet.id, version: expectedVersion },
      { balanceAmount: wallet.balance.formatAmount(), version: wallet.version, updatedAt: wallet.updatedAt },
    );
    if (affected !== 1) {
      throw new TransientInfrastructureError(
        "CONCURRENCY_CONFLICT",
        `Wallet ${wallet.id} changed concurrently (expected version ${expectedVersion})`,
      );
    }
  }
}

class MikroWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<WagerTransaction | undefined> {
    const r = await this.em.findOne(WagerTransactionRecord, { id }, { refresh: true });
    return r ? transactionMapper.toDomain(r) : undefined;
  }

  async lockById(id: string): Promise<WagerTransaction | undefined> {
    const r = await this.em.findOne(
      WagerTransactionRecord,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true },
    );
    return r ? transactionMapper.toDomain(r) : undefined;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined> {
    const r = await this.em.findOne(WagerTransactionRecord, { idempotencyKey }, { refresh: true });
    return r ? transactionMapper.toDomain(r) : undefined;
  }

  async findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    const r = await this.em.findOne(WagerTransactionRecord, { providerId, externalTransactionId }, { refresh: true });
    return r ? transactionMapper.toDomain(r) : undefined;
  }

  async insert(tx: WagerTransaction): Promise<void> {
    this.em.create(WagerTransactionRecord, transactionMapper.toRecord(tx));
  }

  async update(tx: WagerTransaction, expectedStatus: WagerTransactionStatus): Promise<void> {
    const affected = await this.em.nativeUpdate(
      WagerTransactionRecord,
      { id: tx.id, status: expectedStatus },
      transactionMapper.toMutableColumns(tx),
    );
    if (affected !== 1) {
      throw new TransientInfrastructureError(
        "CONCURRENCY_CONFLICT",
        `Transaction ${tx.id} is no longer ${expectedStatus}`,
      );
    }
  }

  async hasProcessedReversalOf(referenceTransactionId: string): Promise<boolean> {
    // Flush first so a reversal persisted earlier in this unit of work is visible.
    await this.em.flush();
    const count = await this.em.count(WagerTransactionRecord, {
      referenceTransactionId,
      status: WagerTransactionStatus.Processed,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
    });
    return count > 0;
  }

  async findDuePendingReferences(now: Date, limit: number): Promise<DuePendingReference[]> {
    const rows = await this.em.find(
      WagerTransactionRecord,
      { status: WagerTransactionStatus.PendingReference, nextReferenceAttemptAt: { $lte: now } },
      { orderBy: { nextReferenceAttemptAt: "asc" }, limit, fields: ["id", "walletId"], refresh: true },
    );
    return rows.map((r) => ({ id: r.id, walletId: r.walletId }));
  }

  async wakeDependents(providerId: string, externalTransactionId: string, now: Date): Promise<number> {
    return this.em.nativeUpdate(
      WagerTransactionRecord,
      {
        status: WagerTransactionStatus.PendingReference,
        providerId,
        referenceExternalTransactionId: externalTransactionId,
        nextReferenceAttemptAt: { $gt: now },
      },
      { nextReferenceAttemptAt: now },
    );
  }
}

class MikroLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(entry: WalletLedgerEntry): Promise<void> {
    this.em.create(LedgerEntryRecord, ledgerMapper.toRecord(entry));
  }

  async page(walletId: string, afterVersion: number | undefined, limit: number): Promise<WalletLedgerEntry[]> {
    const rows = await this.em.find(
      LedgerEntryRecord,
      { walletId, ...(afterVersion !== undefined ? { walletVersion: { $gt: afterVersion } } : {}) },
      { orderBy: { walletVersion: "asc" }, limit, refresh: true },
    );
    return rows.map(ledgerMapper.toDomain);
  }

  async totals(walletId: string, _currency: string): Promise<LedgerTotals> {
    const [row] = await this.em.execute<{ credits: string; debits: string; count: number }[]>(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'CREDIT'), 0)::text AS credits,
              COALESCE(SUM(amount) FILTER (WHERE direction = 'DEBIT'), 0)::text  AS debits,
              COUNT(*)::int AS count
         FROM wallet_ledger_entries WHERE wallet_id = ?`,
      [walletId],
    );
    return { credits: normalize(row!.credits), debits: normalize(row!.debits), count: Number(row!.count) };
  }
}

function normalize(sum: string): string {
  return sum.includes(".") ? sum : `${sum}.00`;
}

class MikroInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async tryReceive(message: InboxMessage): Promise<boolean> {
    // ON CONFLICT DO NOTHING waits for a concurrent in-flight insert of the same
    // key to commit/rollback, so exactly one consumer wins the message.
    const rows = await this.em.execute<{ message_id: string }[]>(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (consumer_name, message_id) DO NOTHING
       RETURNING message_id`,
      [message.consumerName, message.messageId, message.payloadHash, message.receivedAt],
    );
    return rows.length === 1;
  }

  async find(consumerName: string, messageId: string) {
    const r = await this.em.findOne(InboxRecord, { consumerName, messageId }, { refresh: true });
    if (!r) return undefined;
    return { message: inboxMapper.toDomain(r), transactionId: r.transactionId ?? undefined };
  }

  async markProcessed(message: InboxMessage, transactionId: string): Promise<void> {
    await this.em.nativeUpdate(
      InboxRecord,
      { consumerName: message.consumerName, messageId: message.messageId },
      { processedAt: message.processedAt ?? new Date(), transactionId },
    );
  }
}

class MikroOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async add(message: OutboxMessage): Promise<void> {
    this.em.create(OutboxRecord, outboxMapper.toRecord(message));
  }
}

export function createStore(em: EntityManager): WageringStore {
  return {
    wallets: new MikroWalletRepository(em),
    transactions: new MikroWagerTransactionRepository(em),
    ledger: new MikroLedgerRepository(em),
    inbox: new MikroInboxRepository(em),
    outbox: new MikroOutboxRepository(em),
  };
}
