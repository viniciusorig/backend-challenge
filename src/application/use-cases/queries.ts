import type { WagerTransaction } from "../../domain/wagering/wager-transaction";
import type { Wallet } from "../../domain/wallet/wallet";
import type { WalletLedgerEntry } from "../../domain/wallet/wallet-ledger-entry";
import { InvalidRequestError, TransactionNotFoundError, WalletNotFoundError } from "../errors";
import type { UnitOfWork } from "../ports/repositories";

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  nextCursor?: string;
}

/**
 * Opaque, stable cursor: base64url of the last returned wallet version.
 * Wallet versions are unique per wallet and only grow, so pages never skip or
 * repeat lines even while new lines are appended.
 */
export function encodeLedgerCursor(walletVersion: number): string {
  return Buffer.from(JSON.stringify({ v: walletVersion })).toString("base64url");
}

export function decodeLedgerCursor(cursor: string): number {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { v?: unknown };
    if (typeof parsed.v === "number" && Number.isInteger(parsed.v) && parsed.v >= 0) return parsed.v;
  } catch {
    // fallthrough
  }
  throw new InvalidRequestError("Invalid cursor");
}

export class WageringQueries {
  constructor(private readonly uow: UnitOfWork) {}

  async wallet(walletId: string): Promise<Wallet> {
    const wallet = await this.uow.read((s) => s.wallets.findById(walletId));
    if (!wallet) throw new WalletNotFoundError(walletId);
    return wallet;
  }

  async ledger(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPage> {
    const afterVersion = cursor ? decodeLedgerCursor(cursor) : undefined;
    return this.uow.read(async (s) => {
      const wallet = await s.wallets.findById(walletId);
      if (!wallet) throw new WalletNotFoundError(walletId);
      const rows = await s.ledger.page(walletId, afterVersion, limit + 1);
      const entries = rows.slice(0, limit);
      const hasMore = rows.length > limit;
      const last = entries.at(-1);
      return { entries, ...(hasMore && last ? { nextCursor: encodeLedgerCursor(last.walletVersion) } : {}) };
    });
  }

  async transaction(transactionId: string): Promise<WagerTransaction> {
    const tx = await this.uow.read((s) => s.transactions.findById(transactionId));
    if (!tx) throw new TransactionNotFoundError(transactionId);
    return tx;
  }

  async transactionByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction> {
    const tx = await this.uow.read((s) => s.transactions.findByExternalId(providerId, externalTransactionId));
    if (!tx) throw new TransactionNotFoundError(`${providerId}/${externalTransactionId}`);
    return tx;
  }
}
