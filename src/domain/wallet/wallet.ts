import { CurrencyMismatchError, InsufficientFundsError, InvalidArgumentError } from "../errors";
import { Money } from "../money/money";
import { LedgerDirection } from "./ledger-direction";
import { WalletLedgerEntry } from "./wallet-ledger-entry";

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WalletMovement {
  entryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

/**
 * Aggregate root for a player's balance in one currency.
 *
 * Every balance change goes through `debit` / `credit`, which return the
 * ledger entry describing that exact change — balance and ledger cannot drift
 * apart inside the aggregate. `version` starts at 1 and is bumped only when
 * the balance changes; the repository uses it as an optimistic guard on top
 * of the row lock.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Opens a wallet at version 1. A positive opening balance is recorded as the
   * ledger entry returned alongside the wallet (the OPENING transaction).
   */
  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    openingTransactionId: string;
    openingEntryId: string;
    at: Date;
  }): { wallet: Wallet; openingEntry: WalletLedgerEntry | undefined } {
    if (props.initialBalance.isNegative()) {
      throw new InvalidArgumentError("Initial balance cannot be negative");
    }
    const currency = props.initialBalance.currency;
    const wallet = new Wallet(props.id, props.playerId, currency, props.initialBalance, 1, props.at, props.at);
    const openingEntry = props.initialBalance.isPositive()
      ? WalletLedgerEntry.create({
          id: props.openingEntryId,
          walletId: wallet.id,
          transactionId: props.openingTransactionId,
          direction: LedgerDirection.Credit,
          money: props.initialBalance,
          balanceBefore: Money.zero(currency),
          balanceAfter: props.initialBalance,
          walletVersion: 1,
          createdAt: props.at,
        })
      : undefined;
    return { wallet, openingEntry };
  }

  /** Reconstruction from persistence — does not re-validate transitions. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  debit(movement: WalletMovement): WalletLedgerEntry {
    if (!this.canDebit(movement.money)) {
      throw new InsufficientFundsError();
    }
    return this.apply(LedgerDirection.Debit, movement);
  }

  credit(movement: WalletMovement): WalletLedgerEntry {
    this.assertSameCurrency(movement.money);
    return this.apply(LedgerDirection.Credit, movement);
  }

  move(direction: LedgerDirection, movement: WalletMovement): WalletLedgerEntry {
    return direction === LedgerDirection.Debit ? this.debit(movement) : this.credit(movement);
  }

  toState(): WalletState {
    return {
      id: this.id,
      playerId: this.playerId,
      currency: this.currency,
      balance: this._balance,
      version: this._version,
      createdAt: this.createdAt,
      updatedAt: this._updatedAt,
    };
  }

  private apply(direction: LedgerDirection, movement: WalletMovement): WalletLedgerEntry {
    if (!movement.money.isPositive()) {
      throw new InvalidArgumentError("Wallet movements must be positive");
    }
    const before = this._balance;
    const after = direction === LedgerDirection.Credit ? before.add(movement.money) : before.subtract(movement.money);
    // Builds (and validates) the entry before mutating: a failure leaves the aggregate untouched.
    const entry = WalletLedgerEntry.create({
      id: movement.entryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      direction,
      money: movement.money,
      balanceBefore: before,
      balanceAfter: after,
      walletVersion: this._version + 1,
      createdAt: movement.at,
    });
    this._balance = after;
    this._version += 1;
    this._updatedAt = movement.at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (!money.hasCurrency(this.currency)) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
