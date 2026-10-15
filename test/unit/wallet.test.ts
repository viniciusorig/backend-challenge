import { describe, expect, test } from "bun:test";
import { CurrencyMismatchError, InsufficientFundsError, UnbalancedLedgerEntryError } from "../../src/domain/errors";
import { Money } from "../../src/domain/money/money";
import { LedgerDirection } from "../../src/domain/wallet/ledger-direction";
import { Wallet } from "../../src/domain/wallet/wallet";
import { WalletLedgerEntry } from "../../src/domain/wallet/wallet-ledger-entry";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const at = new Date("2026-01-01T00:00:00Z");

function open(amount = "100.00") {
  return Wallet.open({ id: "w1", playerId: "p1", initialBalance: brl(amount), openingTransactionId: "t0", openingEntryId: "e0", at });
}

describe("Wallet", () => {
  test("opens at version 1 with an OPENING credit entry when the balance is positive", () => {
    const { wallet, openingEntry } = open("100.00");
    expect(wallet.version).toBe(1);
    expect(wallet.balance.formatAmount()).toBe("100.00");
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.balanceAfter.equals(wallet.balance)).toBe(true);
    expect(openingEntry?.walletVersion).toBe(1);
  });

  test("opens empty without ledger entry", () => {
    const { wallet, openingEntry } = open("0.00");
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeUndefined();
  });

  test("debit and credit return the matching ledger entry and bump the version", () => {
    const { wallet } = open();
    const debit = wallet.debit({ entryId: "e1", transactionId: "t1", money: brl("30.00"), at });
    expect(wallet.balance.formatAmount()).toBe("70.00");
    expect(wallet.version).toBe(2);
    expect(debit.balanceBefore.formatAmount()).toBe("100.00");
    expect(debit.balanceAfter.formatAmount()).toBe("70.00");
    expect(debit.walletVersion).toBe(2);

    const credit = wallet.credit({ entryId: "e2", transactionId: "t2", money: brl("5.50"), at });
    expect(wallet.balance.formatAmount()).toBe("75.50");
    expect(wallet.version).toBe(3);
    expect(credit.isBalanced()).toBe(true);
  });

  test("never goes negative and stays untouched on failure", () => {
    const { wallet } = open("100.00");
    expect(() => wallet.debit({ entryId: "e1", transactionId: "t1", money: brl("100.01"), at })).toThrow(
      InsufficientFundsError,
    );
    expect(wallet.balance.formatAmount()).toBe("100.00");
    expect(wallet.version).toBe(1);
    wallet.debit({ entryId: "e1", transactionId: "t1", money: brl("100.00"), at });
    expect(wallet.balance.isZero()).toBe(true);
  });

  test("rejects other currencies", () => {
    const { wallet } = open();
    const usd = Money.from({ amount: "1.00", currency: "USD" });
    expect(() => wallet.credit({ entryId: "e", transactionId: "t", money: usd, at })).toThrow(CurrencyMismatchError);
    expect(() => wallet.canDebit(usd)).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });

  test("rehydrate restores state without re-validating", () => {
    const w = Wallet.rehydrate({ id: "w", playerId: "p", currency: "BRL", balance: brl("1.00"), version: 7, createdAt: at, updatedAt: at });
    expect(w.version).toBe(7);
  });
});

describe("WalletLedgerEntry", () => {
  test("factory verifies the arithmetic", () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: "e",
        walletId: "w",
        transactionId: "t",
        direction: LedgerDirection.Debit,
        money: brl("10.00"),
        balanceBefore: brl("50.00"),
        balanceAfter: brl("45.00"),
        walletVersion: 2,
        createdAt: at,
      }),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  test("is structurally immutable", () => {
    const { openingEntry } = open();
    expect(Object.isFrozen(openingEntry)).toBe(true);
    expect(() => {
      (openingEntry as unknown as { direction: string }).direction = "DEBIT";
    }).toThrow();
  });
});
