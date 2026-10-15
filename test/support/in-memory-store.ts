import type { UnitOfWork, WageringStore } from "../../src/application/ports/repositories";
import { UniqueViolationError } from "../../src/application/errors";
import type { InboxMessage } from "../../src/domain/messaging/inbox-message";
import type { OutboxMessage } from "../../src/domain/messaging/outbox-message";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../src/domain/wagering/wager-transaction";
import { Wallet } from "../../src/domain/wallet/wallet";
import type { WalletLedgerEntry } from "../../src/domain/wallet/wallet-ledger-entry";

/**
 * UNIT-TEST ONLY fake of the persistence ports (sequential, no concurrency).
 * Integration and concurrency tests always run against real PostgreSQL / SQS.
 */
export class InMemoryUnitOfWork implements UnitOfWork {
  wallets = new Map<string, Wallet>();
  transactions = new Map<string, WagerTransaction>();
  ledger: WalletLedgerEntry[] = [];
  inbox = new Map<string, { message: InboxMessage; transactionId?: string }>();
  outbox: OutboxMessage[] = [];

  async transactional<T>(work: (store: WageringStore) => Promise<T>): Promise<T> {
    const snapshot = {
      wallets: new Map([...this.wallets].map(([k, w]) => [k, Wallet.rehydrate(w.toState())])),
      transactions: new Map([...this.transactions].map(([k, t]) => [k, WagerTransaction.rehydrate(t.toState())])),
      ledger: [...this.ledger],
      inbox: new Map(this.inbox),
      outbox: [...this.outbox],
    };
    try {
      return await work(this.store());
    } catch (error) {
      Object.assign(this, snapshot);
      throw error;
    }
  }

  read<T>(work: (store: WageringStore) => Promise<T>): Promise<T> {
    return work(this.store());
  }

  private clone = (t: WagerTransaction | undefined) => (t ? WagerTransaction.rehydrate(t.toState()) : undefined);
  private cloneWallet = (w: Wallet | undefined) => (w ? Wallet.rehydrate(w.toState()) : undefined);

  private store(): WageringStore {
    const self = this;
    return {
      wallets: {
        findById: async (id) => self.cloneWallet(self.wallets.get(id)),
        lockForUpdate: async (id) => self.cloneWallet(self.wallets.get(id)),
        lockForShare: async (id) => self.cloneWallet(self.wallets.get(id)),
        findByPlayerAndCurrency: async (p, c) =>
          self.cloneWallet([...self.wallets.values()].find((w) => w.playerId === p && w.currency === c)),
        insert: async (w) => {
          if ([...self.wallets.values()].some((x) => x.playerId === w.playerId && x.currency === w.currency)) {
            throw new UniqueViolationError("wallets_player_currency_uq");
          }
          self.wallets.set(w.id, Wallet.rehydrate(w.toState()));
        },
        saveBalance: async (w, expected) => {
          const current = self.wallets.get(w.id)!;
          if (current.version !== expected) throw new Error("version conflict");
          self.wallets.set(w.id, Wallet.rehydrate(w.toState()));
        },
      },
      transactions: {
        findById: async (id) => self.clone(self.transactions.get(id)),
        lockById: async (id) => self.clone(self.transactions.get(id)),
        findByIdempotencyKey: async (k) => self.clone([...self.transactions.values()].find((t) => t.idempotencyKey === k)),
        findByExternalId: async (p, e) =>
          self.clone([...self.transactions.values()].find((t) => t.providerId === p && t.externalTransactionId === e)),
        insert: async (t) => {
          if ([...self.transactions.values()].some((x) => x.idempotencyKey === t.idempotencyKey)) {
            throw new UniqueViolationError("wager_tx_idempotency_key_uq");
          }
          self.transactions.set(t.id, WagerTransaction.rehydrate(t.toState()));
        },
        update: async (t, expected) => {
          if (self.transactions.get(t.id)?.status !== expected) throw new Error("status conflict");
          self.transactions.set(t.id, WagerTransaction.rehydrate(t.toState()));
        },
        hasProcessedReversalOf: async (refId) =>
          [...self.transactions.values()].some(
            (t) =>
              t.referenceTransactionId === refId &&
              t.status === WagerTransactionStatus.Processed &&
              (t.kind === WagerTransactionKind.Refund || t.kind === WagerTransactionKind.Rollback),
          ),
        findDuePendingReferences: async (now, limit) =>
          [...self.transactions.values()]
            .filter((t) => t.status === WagerTransactionStatus.PendingReference && t.nextReferenceAttemptAt! <= now)
            .slice(0, limit)
            .map((t) => ({ id: t.id, walletId: t.walletId })),
        wakeDependents: async () => 0,
      },
      ledger: {
        insert: async (e) => {
          self.ledger.push(e);
        },
        page: async (walletId, after, limit) =>
          self.ledger.filter((e) => e.walletId === walletId && (after === undefined || e.walletVersion > after)).slice(0, limit),
        totals: async () => ({ credits: "0.00", debits: "0.00", count: 0 }),
      },
      inbox: {
        tryReceive: async (m) => {
          const key = `${m.consumerName}/${m.messageId}`;
          if (self.inbox.has(key)) return false;
          self.inbox.set(key, { message: m });
          return true;
        },
        find: async (c, id) => self.inbox.get(`${c}/${id}`),
        markProcessed: async (m, transactionId) => {
          self.inbox.set(`${m.consumerName}/${m.messageId}`, { message: m, transactionId });
        },
      },
      outbox: {
        add: async (m) => {
          self.outbox.push(m);
        },
      },
    };
  }

  /** Σ ledger of a wallet (signed). */
  ledgerBalance(walletId: string): string {
    const entries = this.ledger.filter((e) => e.walletId === walletId);
    let total = entries[0]?.money.subtract(entries[0].money);
    for (const e of entries) total = total!.add(e.signedAmount());
    return total?.formatAmount() ?? "0.00";
  }
}
