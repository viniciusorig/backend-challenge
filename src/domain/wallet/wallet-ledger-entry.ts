import { InvalidArgumentError, UnbalancedLedgerEntryError } from "../errors";
import { Money } from "../money/money";
import { LedgerDirection } from "./ledger-direction";

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  /** Wallet version produced by this entry. Ties every entry to exactly one balance change. */
  walletVersion: number;
  createdAt: Date;
}

export type LedgerEntryState = CreateLedgerEntryProps;

/**
 * Immutable ledger line. There are no setters and no transition methods:
 * once created it can only be read. The database enforces the same with a
 * trigger that rejects UPDATE / DELETE / TRUNCATE.
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly walletVersion: number,
    public readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    if (!props.money.isPositive()) {
      throw new InvalidArgumentError("Ledger entry amount must be positive");
    }
    if (props.balanceAfter.isNegative()) {
      throw new InvalidArgumentError("Ledger entry cannot produce a negative balance");
    }
    const entry = WalletLedgerEntry.build(props);
    if (!entry.isBalanced()) {
      throw new UnbalancedLedgerEntryError(
        `Unbalanced ledger entry: ${entry.balanceBefore} ${entry.direction} ${entry.money} != ${entry.balanceAfter}`,
      );
    }
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return WalletLedgerEntry.build(state);
  }

  /** balanceBefore ± money === balanceAfter */
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }

  /** Signed effect on the balance: +money for credits, -money for debits. */
  signedAmount(): Money {
    return this.direction === LedgerDirection.Credit ? this.money : this.money.negate();
  }

  private static build(p: CreateLedgerEntryProps): WalletLedgerEntry {
    return new WalletLedgerEntry(
      p.id,
      p.walletId,
      p.transactionId,
      p.direction,
      p.money,
      p.balanceBefore,
      p.balanceAfter,
      p.walletVersion,
      p.createdAt,
    );
  }
}
