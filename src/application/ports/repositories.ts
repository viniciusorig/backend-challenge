import type { InboxMessage } from "../../domain/messaging/inbox-message";
import type { OutboxMessage } from "../../domain/messaging/outbox-message";
import type { WagerTransaction, WagerTransactionStatus } from "../../domain/wagering/wager-transaction";
import type { Wallet } from "../../domain/wallet/wallet";
import type { WalletLedgerEntry } from "../../domain/wallet/wallet-ledger-entry";

export interface WalletRepository {
  findById(id: string): Promise<Wallet | undefined>;
  /** SELECT ... FOR UPDATE: serializes every writer of this wallet until commit. */
  lockForUpdate(id: string): Promise<Wallet | undefined>;
  /** SELECT ... FOR SHARE: stable snapshot of the wallet against concurrent writers. */
  lockForShare(id: string): Promise<Wallet | undefined>;
  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined>;
  insert(wallet: Wallet): Promise<void>;
  /**
   * Persists a balance change guarded by `expectedVersion` (UPDATE ... WHERE
   * version = expected). Throws TransientInfrastructureError(CONCURRENCY_CONFLICT)
   * if the row moved underneath.
   */
  saveBalance(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface DuePendingReference {
  id: string;
  walletId: string;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | undefined>;
  lockById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(key: string): Promise<WagerTransaction | undefined>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  insert(tx: WagerTransaction): Promise<void>;
  /** Guarded update: only succeeds if the stored status is still `expectedStatus`. */
  update(tx: WagerTransaction, expectedStatus: WagerTransactionStatus): Promise<void>;
  hasProcessedReversalOf(referenceTransactionId: string): Promise<boolean>;
  findDuePendingReferences(now: Date, limit: number): Promise<DuePendingReference[]>;
  /** Makes PENDING_REFERENCE transactions waiting on (provider, externalId) due now. */
  wakeDependents(providerId: string, externalTransactionId: string, now: Date): Promise<number>;
}

export interface LedgerTotals {
  credits: string;
  debits: string;
  count: number;
}

export interface LedgerRepository {
  insert(entry: WalletLedgerEntry): Promise<void>;
  /** Entries ordered by wallet version, strictly after `afterVersion`. */
  page(walletId: string, afterVersion: number | undefined, limit: number): Promise<WalletLedgerEntry[]>;
  totals(walletId: string, currency: string): Promise<LedgerTotals>;
}

export interface InboxRepository {
  /** INSERT ... ON CONFLICT DO NOTHING. false = the message was already consumed (committed). */
  tryReceive(message: InboxMessage): Promise<boolean>;
  find(consumerName: string, messageId: string): Promise<{ message: InboxMessage; transactionId?: string } | undefined>;
  markProcessed(message: InboxMessage, transactionId: string): Promise<void>;
}

export interface OutboxRepository {
  add(message: OutboxMessage): Promise<void>;
}

export interface WageringStore {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

export interface UnitOfWork {
  /** Runs `work` in one SQL transaction (commit on success, rollback on throw). */
  transactional<T>(work: (store: WageringStore) => Promise<T>): Promise<T>;
  /** Read-only access outside of an explicit transaction. */
  read<T>(work: (store: WageringStore) => Promise<T>): Promise<T>;
}

export const UNIT_OF_WORK = Symbol("UNIT_OF_WORK");
