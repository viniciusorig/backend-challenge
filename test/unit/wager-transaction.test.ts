import { describe, expect, test } from "bun:test";
import { InvalidArgumentError, InvalidTransactionStateError } from "../../src/domain/errors";
import { Money } from "../../src/domain/money/money";
import { FailureCode } from "../../src/domain/wagering/failure-code";
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind as K,
  WagerTransactionStatus as S,
} from "../../src/domain/wagering/wager-transaction";
import { LedgerDirection } from "../../src/domain/wallet/ledger-direction";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const now = new Date("2026-01-01T00:00:00Z");

function make(kind: K, extra: Partial<CreateWagerTransactionProps> = {}) {
  return WagerTransaction.create({
    id: `id-${kind}`,
    providerId: "p",
    externalTransactionId: `ext-${kind}`,
    idempotencyKey: `p:ext-${kind}`,
    payloadHash: "h",
    walletId: "w",
    playerId: "pl",
    roundId: "r",
    gameId: "g",
    kind,
    money: brl("10.00"),
    correlationId: "c",
    createdAt: now,
    ...(kind === K.Refund || kind === K.Rollback ? { referenceExternalTransactionId: "ext-BET" } : {}),
    ...extra,
  });
}

describe("WagerTransaction", () => {
  test("is born PENDING", () => {
    expect<string | undefined>(make(K.Bet).status).toBe(S.Pending);
  });

  test("REFUND and ROLLBACK require a reference", () => {
    expect(() => make(K.Refund, { referenceExternalTransactionId: undefined })).toThrow(InvalidArgumentError);
    expect(() => make(K.Rollback, { referenceExternalTransactionId: undefined })).toThrow(InvalidArgumentError);
    expect(make(K.Refund).requiresReference()).toBe(true);
    expect(make(K.Win).requiresReference()).toBe(false);
  });

  test("amount rules: LOSS may be zero, other kinds must be positive", () => {
    expect(make(K.Loss, { money: brl("0.00") }).affectsBalance()).toBe(false);
    expect(() => make(K.Bet, { money: brl("0.00") })).toThrow(InvalidArgumentError);
    expect(() => make(K.Bet, { referenceExternalTransactionId: "x" })).toThrow(InvalidArgumentError);
  });

  test("terminal states are final", () => {
    const tx = make(K.Bet);
    tx.markProcessed(undefined, now, brl("90.00"));
    expect(tx.isTerminal()).toBe(true);
    expect(() => tx.reject(FailureCode.InsufficientFunds, now, brl("0.00"))).toThrow(InvalidTransactionStateError);
    expect(() => tx.fail(FailureCode.ProcessingError, now)).toThrow(InvalidTransactionStateError);
    expect(() => tx.markProcessed(undefined, now, brl("0.00"))).toThrow(InvalidTransactionStateError);

    const rejected = make(K.Win);
    rejected.reject(FailureCode.CurrencyMismatch, now, brl("1.00"));
    expect(() => rejected.markProcessed(undefined, now, brl("1.00"))).toThrow(InvalidTransactionStateError);
  });

  test("PENDING_REFERENCE can be rescheduled, then resolved", () => {
    const tx = make(K.Refund);
    tx.markPendingReference(new Date(now.getTime() + 1000), brl("5.00"));
    expect<string | undefined>(tx.status).toBe(S.PendingReference);
    tx.scheduleReferenceRetry(new Date(now.getTime() + 2000));
    expect(tx.referenceAttempts).toBe(1);
    expect(() => tx.markPendingReference(now, brl("0.00"))).toThrow(InvalidTransactionStateError);
    tx.markProcessed("ref", now, brl("15.00"));
    expect<string | undefined>(tx.status).toBe(S.Processed);
    expect(tx.nextReferenceAttemptAt).toBeUndefined();
  });

  test("ledger direction per kind; ROLLBACK inverts its reference", () => {
    const bet = make(K.Bet);
    const win = make(K.Win);
    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(make(K.Refund).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(make(K.Rollback).ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(make(K.Rollback).ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(() => make(K.Loss).ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
  });

  test("checkReference enforces kind, scope, status and amount", () => {
    const bet = make(K.Bet);
    const refund = make(K.Refund);
    expect(refund.checkReference(bet)).toEqual({ ok: false, wait: true }); // BET still PENDING
    bet.markProcessed(undefined, now, brl("90.00"));
    expect(refund.checkReference(bet)).toEqual({ ok: true });

    expect(make(K.Refund, { roundId: "other" }).checkReference(bet)).toMatchObject({ code: FailureCode.ReferenceMismatch });
    expect(make(K.Refund, { playerId: "other" }).checkReference(bet)).toMatchObject({ code: FailureCode.ReferenceMismatch });
    expect(make(K.Refund, { providerId: "other" }).checkReference(bet)).toMatchObject({ code: FailureCode.ReferenceMismatch });
    expect(make(K.Refund, { money: brl("9.99") }).checkReference(bet)).toMatchObject({
      code: FailureCode.ReferenceAmountMismatch,
    });

    const win = make(K.Win);
    win.markProcessed(undefined, now, brl("100.00"));
    expect(make(K.Refund).checkReference(win)).toMatchObject({ code: FailureCode.ReferenceInvalidKind });
    expect(make(K.Rollback).checkReference(win)).toEqual({ ok: true });

    const rejectedBet = make(K.Bet);
    rejectedBet.reject(FailureCode.InsufficientFunds, now, brl("0.00"));
    expect(make(K.Refund).checkReference(rejectedBet)).toMatchObject({ code: FailureCode.ReferenceNotProcessed });
  });

  test("payload match", () => {
    expect(make(K.Bet).matchesPayload("h")).toBe(true);
    expect(make(K.Bet).matchesPayload("other")).toBe(false);
  });
});
