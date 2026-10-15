import type { ReconciliationReport } from "../../application/use-cases/reconcile-wallet";
import type { WagerTransaction } from "../../domain/wagering/wager-transaction";
import type { Wallet } from "../../domain/wallet/wallet";
import type { WalletLedgerEntry } from "../../domain/wallet/wallet-ledger-entry";

export const presentWallet = (w: Wallet) => ({
  id: w.id,
  playerId: w.playerId,
  balance: w.balance.toJSON(),
  version: w.version,
  createdAt: w.createdAt.toISOString(),
  updatedAt: w.updatedAt.toISOString(),
});

export const presentLedgerEntry = (e: WalletLedgerEntry) => ({
  id: e.id,
  transactionId: e.transactionId,
  direction: e.direction,
  money: e.money.toJSON(),
  balanceBefore: e.balanceBefore.toJSON(),
  balanceAfter: e.balanceAfter.toJSON(),
  walletVersion: e.walletVersion,
  createdAt: e.createdAt.toISOString(),
});

export const presentTransaction = (tx: WagerTransaction) => ({
  transactionId: tx.id,
  providerId: tx.providerId,
  externalTransactionId: tx.externalTransactionId,
  walletId: tx.walletId,
  playerId: tx.playerId,
  roundId: tx.roundId,
  gameId: tx.gameId,
  kind: tx.kind,
  money: tx.money.toJSON(),
  referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
  referenceTransactionId: tx.referenceTransactionId ?? null,
  status: tx.status,
  failureCode: tx.failureCode ?? null,
  balance: tx.observedBalance?.toJSON() ?? null,
  createdAt: tx.createdAt.toISOString(),
  processedAt: tx.processedAt?.toISOString() ?? null,
});

/** Response of POST /wagering/transactions — identical on replay except `idempotentReplay`. */
export const presentSubmission = (tx: WagerTransaction, idempotentReplay: boolean) => ({
  transactionId: tx.id,
  status: tx.status,
  balance: tx.observedBalance?.toJSON() ?? null,
  ...(tx.failureCode ? { failureCode: tx.failureCode } : {}),
  idempotentReplay,
});

export const presentReconciliation = (r: ReconciliationReport) => ({
  walletId: r.walletId,
  storedBalance: r.storedBalance.toJSON(),
  calculatedBalance: r.calculatedBalance.toJSON(),
  difference: r.difference.toJSON(),
  consistent: r.consistent,
  checkedEntries: r.checkedEntries,
});
