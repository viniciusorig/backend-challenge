import { beforeEach, describe, expect, test } from "bun:test";
import type { SubmitWagerCommand } from "../../src/application/commands";
import { IdempotencyConflictError, InvalidRequestError, WalletNotFoundError } from "../../src/application/errors";
import { noopMetrics } from "../../src/application/ports/metrics";
import { OpenWallet } from "../../src/application/use-cases/open-wallet";
import { ResolvePendingReferences } from "../../src/application/use-cases/resolve-pending-references";
import { SubmitWagerTransaction } from "../../src/application/use-cases/submit-wager-transaction";
import { WagerDecisionService } from "../../src/application/wager-decision";
import { FailureCode } from "../../src/domain/wagering/failure-code";
import { InMemoryUnitOfWork } from "../support/in-memory-store";

let clockNow = new Date("2026-01-01T00:00:00Z");
const clock = { now: () => clockNow };
let uow: InMemoryUnitOfWork;
let submit: SubmitWagerTransaction;
let resolver: ResolvePendingReferences;
let wallet: { walletId: string; playerId: string };

const opts = { source: "http" as const, correlationId: "c" };
let seq = 0;
function cmd(kind: string, amount: string, extra: Partial<SubmitWagerCommand> = {}): SubmitWagerCommand {
  const ext = extra.externalTransactionId ?? `ext-${++seq}`;
  return {
    idempotencyKey: `prov:${ext}`,
    providerId: "prov",
    externalTransactionId: ext,
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: "r1",
    gameId: "g",
    kind,
    money: { amount, currency: "BRL" },
    ...extra,
  };
}
const balance = async () => (await uow.read((s) => s.wallets.findById(wallet.walletId)))!.balance.formatAmount();

beforeEach(async () => {
  clockNow = new Date("2026-01-01T00:00:00Z");
  uow = new InMemoryUnitOfWork();
  const decisions = new WagerDecisionService({ baseDelayMs: 1000, maxDelayMs: 4000, maxAttempts: 3 });
  submit = new SubmitWagerTransaction(uow, decisions, clock, noopMetrics, 1);
  resolver = new ResolvePendingReferences(uow, decisions, clock, noopMetrics, 1);
  const w = await new OpenWallet(uow, clock).execute({ playerId: "pl", initialBalance: { amount: "100.00", currency: "BRL" } }, "c");
  wallet = { walletId: w.id, playerId: w.playerId };
});

describe("BET", () => {
  test("debits and writes one DEBIT entry + events", async () => {
    const r = await submit.execute(cmd("BET", "25.00"), opts);
    expect<string | undefined>(r.transaction.status).toBe("PROCESSED");
    expect(r.transaction.observedBalance?.formatAmount()).toBe("75.00");
    expect(await balance()).toBe("75.00");
    expect(uow.ledger.filter((e) => e.transactionId === r.transaction.id).map((e) => String(e.direction))).toEqual(["DEBIT"]);
    expect(uow.outbox.slice(-2).map((m) => m.eventType)).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);
  });

  test("insufficient funds → REJECTED, no ledger, no balance change", async () => {
    const r = await submit.execute(cmd("BET", "100.01"), opts);
    expect<string | undefined>(r.transaction.status).toBe("REJECTED");
    expect<string | undefined>(r.transaction.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(await balance()).toBe("100.00");
    expect(uow.ledger.some((e) => e.transactionId === r.transaction.id)).toBe(false);
    expect(uow.outbox.at(-1)?.eventType).toBe("WagerTransactionRejected");
  });
});

describe("WIN / LOSS", () => {
  test("WIN credits", async () => {
    const r = await submit.execute(cmd("WIN", "50.00"), opts);
    expect<string | undefined>(r.transaction.status).toBe("PROCESSED");
    expect(await balance()).toBe("150.00");
  });

  test("WIN may reference the BET of the same round", async () => {
    await submit.execute(cmd("BET", "10.00", { externalTransactionId: "b1" }), opts);
    const r = await submit.execute(cmd("WIN", "30.00", { referenceExternalTransactionId: "b1" }), opts);
    expect<string | undefined>(r.transaction.status).toBe("PROCESSED");
    expect(r.transaction.referenceTransactionId).toBeDefined();
    expect(await balance()).toBe("120.00");
  });

  test("LOSS records the outcome without moving the balance or the ledger", async () => {
    const before = uow.ledger.length;
    const r = await submit.execute(cmd("LOSS", "0.00"), opts);
    expect<string | undefined>(r.transaction.status).toBe("PROCESSED");
    expect(await balance()).toBe("100.00");
    expect(uow.ledger.length).toBe(before);
    expect(uow.outbox.at(-1)?.eventType).toBe("WagerTransactionProcessed");
    const versionAfter = (await uow.read((s) => s.wallets.findById(wallet.walletId)))!.version;
    expect(versionAfter).toBe(1); // version only moves with the balance
  });
});

describe("REFUND", () => {
  test("credits back a processed BET exactly once", async () => {
    await submit.execute(cmd("BET", "40.00", { externalTransactionId: "b1" }), opts);
    const first = await submit.execute(cmd("REFUND", "40.00", { referenceExternalTransactionId: "b1" }), opts);
    expect<string | undefined>(first.transaction.status).toBe("PROCESSED");
    expect(await balance()).toBe("100.00");
    const second = await submit.execute(cmd("REFUND", "40.00", { referenceExternalTransactionId: "b1" }), opts);
    expect<string | undefined>(second.transaction.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    const rollbackToo = await submit.execute(cmd("ROLLBACK", "40.00", { referenceExternalTransactionId: "b1" }), opts);
    expect<string | undefined>(rollbackToo.transaction.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    expect(await balance()).toBe("100.00");
  });

  test("only targets BET, same amount, same round", async () => {
    await submit.execute(cmd("WIN", "5.00", { externalTransactionId: "w1" }), opts);
    await submit.execute(cmd("BET", "10.00", { externalTransactionId: "b1" }), opts);
    const onWin = await submit.execute(cmd("REFUND", "5.00", { referenceExternalTransactionId: "w1" }), opts);
    expect<string | undefined>(onWin.transaction.failureCode).toBe(FailureCode.ReferenceInvalidKind);
    const partial = await submit.execute(cmd("REFUND", "5.00", { referenceExternalTransactionId: "b1" }), opts);
    expect<string | undefined>(partial.transaction.failureCode).toBe(FailureCode.ReferenceAmountMismatch);
    const otherRound = await submit.execute(cmd("REFUND", "10.00", { referenceExternalTransactionId: "b1", roundId: "r2" }), opts);
    expect<string | undefined>(otherRound.transaction.failureCode).toBe(FailureCode.ReferenceMismatch);
  });

  test("cannot revert a REJECTED bet", async () => {
    await submit.execute(cmd("BET", "999.00", { externalTransactionId: "b1" }), opts);
    const r = await submit.execute(cmd("REFUND", "999.00", { referenceExternalTransactionId: "b1" }), opts);
    expect<string | undefined>(r.transaction.failureCode).toBe(FailureCode.ReferenceNotProcessed);
  });
});

describe("ROLLBACK", () => {
  test("of a BET credits, of a WIN debits", async () => {
    await submit.execute(cmd("BET", "30.00", { externalTransactionId: "b1" }), opts);
    await submit.execute(cmd("WIN", "60.00", { externalTransactionId: "w1" }), opts);
    expect(await balance()).toBe("130.00");
    await submit.execute(cmd("ROLLBACK", "60.00", { referenceExternalTransactionId: "w1" }), opts);
    expect(await balance()).toBe("70.00");
    await submit.execute(cmd("ROLLBACK", "30.00", { referenceExternalTransactionId: "b1" }), opts);
    expect(await balance()).toBe("100.00");
  });

  test("of a REFUND debits again", async () => {
    await submit.execute(cmd("BET", "30.00", { externalTransactionId: "b1" }), opts);
    await submit.execute(cmd("REFUND", "30.00", { externalTransactionId: "rf1", referenceExternalTransactionId: "b1" }), opts);
    const r = await submit.execute(cmd("ROLLBACK", "30.00", { referenceExternalTransactionId: "rf1" }), opts);
    expect<string | undefined>(r.transaction.status).toBe("PROCESSED");
    expect(await balance()).toBe("70.00");
  });

  test("that would overdraw is rejected with its own failure code", async () => {
    await submit.execute(cmd("WIN", "50.00", { externalTransactionId: "w1" }), opts);
    await submit.execute(cmd("BET", "140.00"), opts);
    expect(await balance()).toBe("10.00");
    const r = await submit.execute(cmd("ROLLBACK", "50.00", { referenceExternalTransactionId: "w1" }), opts);
    expect<string | undefined>(r.transaction.status).toBe("REJECTED");
    expect<string | undefined>(r.transaction.failureCode).toBe(FailureCode.ReversalInsufficientFunds);
    expect<string | undefined>(r.transaction.failureCode).not.toBe(FailureCode.InsufficientFunds);
    expect(await balance()).toBe("10.00");
  });
});

describe("validation and coherence", () => {
  test("currency conflict is rejected (persisted, auditable)", async () => {
    const r = await submit.execute(cmd("BET", "1.00", { money: { amount: "1.00", currency: "USD" } }), opts);
    expect<string | undefined>(r.transaction.status).toBe("REJECTED");
    expect<string | undefined>(r.transaction.failureCode).toBe(FailureCode.CurrencyMismatch);
  });

  test("player must own the wallet", async () => {
    const r = await submit.execute(cmd("BET", "1.00", { playerId: "intruder" }), opts);
    expect<string | undefined>(r.transaction.failureCode).toBe(FailureCode.PlayerWalletMismatch);
  });

  test("OPENING and the internal provider cannot be submitted", async () => {
    await expect(submit.execute(cmd("OPENING", "1.00"), opts)).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(submit.execute(cmd("BET", "1.00", { providerId: "__internal__" }), opts)).rejects.toBeInstanceOf(
      InvalidRequestError,
    );
  });

  test("invalid money is a validation error", async () => {
    await expect(submit.execute(cmd("BET", "1.001"), opts)).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(submit.execute(cmd("BET", "-1.00"), opts)).rejects.toBeInstanceOf(InvalidRequestError);
  });

  test("unknown wallet", async () => {
    await expect(
      submit.execute(cmd("BET", "1.00", { walletId: "00000000-0000-7000-8000-000000000000" }), opts),
    ).rejects.toBeInstanceOf(WalletNotFoundError);
  });
});

describe("idempotency", () => {
  test("same key + same payload → original result, including the balance seen then", async () => {
    const first = await submit.execute(cmd("BET", "10.00", { externalTransactionId: "b1" }), opts);
    await submit.execute(cmd("BET", "20.00"), opts); // balance moves on
    const replay = await submit.execute(cmd("BET", "10.00", { externalTransactionId: "b1" }), opts);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transaction.id).toBe(first.transaction.id);
    expect(replay.transaction.observedBalance?.formatAmount()).toBe("90.00");
    expect(await balance()).toBe("70.00");
  });

  test("amount format is normalized before hashing", async () => {
    await submit.execute(cmd("BET", "10.00", { externalTransactionId: "b1" }), opts);
    const replay = await submit.execute(cmd("BET", "10", { externalTransactionId: "b1" }), opts);
    expect(replay.idempotentReplay).toBe(true);
  });

  test("same key + different payload → conflict, not replay", async () => {
    await submit.execute(cmd("BET", "10.00", { externalTransactionId: "b1" }), opts);
    const error = await submit.execute(cmd("BET", "11.00", { externalTransactionId: "b1" }), opts).catch((e) => e);
    expect(error).toBeInstanceOf(IdempotencyConflictError);
    expect(error.code).toBe("IDEMPOTENCY_KEY_CONFLICT");
    expect(await balance()).toBe("90.00");
  });

  test("same external id under another key → conflict", async () => {
    await submit.execute(cmd("BET", "10.00", { externalTransactionId: "b1" }), opts);
    const error = await submit
      .execute(cmd("BET", "10.00", { externalTransactionId: "b1", idempotencyKey: "other-key" }), opts)
      .catch((e) => e);
    expect(error.code).toBe("EXTERNAL_TRANSACTION_ID_CONFLICT");
  });

  test("race: duplicate commits between the key lookup and the external-id lookup → replay, not conflict", async () => {
    const first = await submit.execute(cmd("BET", "10.00", { externalTransactionId: "b1" }), opts);
    // Reproduce the READ COMMITTED window: the key lookup misses, the external-id lookup sees the committed row.
    const original = uow.transactional.bind(uow);
    let missedOnce = false;
    uow.transactional = (work) =>
      original((store) =>
        work({
          ...store,
          transactions: {
            ...store.transactions,
            findByIdempotencyKey: async (key) => {
              if (!missedOnce) {
                missedOnce = true;
                return undefined;
              }
              return store.transactions.findByIdempotencyKey(key);
            },
          },
        }),
      );
    const replay = await submit.execute(cmd("BET", "10.00", { externalTransactionId: "b1" }), opts);
    expect(missedOnce).toBe(true);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transaction.id).toBe(first.transaction.id);
  });

  test("rejections are replayed too", async () => {
    const first = await submit.execute(cmd("BET", "500.00", { externalTransactionId: "b1" }), opts);
    const replay = await submit.execute(cmd("BET", "500.00", { externalTransactionId: "b1" }), opts);
    expect<string | undefined>(replay.transaction.status).toBe("REJECTED");
    expect(replay.transaction.id).toBe(first.transaction.id);
    expect(replay.idempotentReplay).toBe(true);
  });

  test("inbox: redelivered message is a duplicate; same id with other payload is a conflict", async () => {
    const inbox = { consumerName: "c", messageId: "m1", payloadHash: "h1" };
    const first = await submit.execute(cmd("BET", "10.00", { externalTransactionId: "b1" }), { ...opts, inbox });
    const again = await submit.execute(cmd("BET", "10.00", { externalTransactionId: "b1" }), { ...opts, inbox });
    expect(again.duplicateMessage).toBe(true);
    expect(again.transaction.id).toBe(first.transaction.id);
    await expect(
      submit.execute(cmd("BET", "10.00", { externalTransactionId: "b1" }), { ...opts, inbox: { ...inbox, payloadHash: "h2" } }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });
});

describe("out-of-order references", () => {
  test("REFUND before its BET waits as PENDING_REFERENCE, then resolves", async () => {
    const early = await submit.execute(cmd("REFUND", "10.00", { referenceExternalTransactionId: "b1" }), opts);
    expect<string | undefined>(early.transaction.status).toBe("PENDING_REFERENCE");
    expect(uow.outbox.at(-1)?.eventType).toBe("WagerTransactionPendingReference");
    await submit.execute(cmd("BET", "10.00", { externalTransactionId: "b1" }), opts);
    expect(await balance()).toBe("90.00");

    clockNow = new Date(clockNow.getTime() + 10_000);
    const report = await resolver.runOnce(10);
    expect(report.resolved).toBe(1);
    expect<string | undefined>((await uow.read((s) => s.transactions.findById(early.transaction.id)))!.status).toBe("PROCESSED");
    expect(await balance()).toBe("100.00");
  });

  test("gives up after maxAttempts with REFERENCE_NOT_FOUND", async () => {
    const early = await submit.execute(cmd("ROLLBACK", "10.00", { referenceExternalTransactionId: "never" }), opts);
    for (let i = 0; i < 5; i++) {
      clockNow = new Date(clockNow.getTime() + 60_000);
      await resolver.runOnce(10);
    }
    const tx = (await uow.read((s) => s.transactions.findById(early.transaction.id)))!;
    expect<string | undefined>(tx.status).toBe("REJECTED");
    expect<string | undefined>(tx.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(tx.referenceAttempts).toBe(2);
    expect(uow.outbox.at(-1)?.eventType).toBe("WagerTransactionRejected");
  });
});

test("invariant: balance == ledger", async () => {
  await submit.execute(cmd("BET", "10.00", { externalTransactionId: "b1" }), opts);
  await submit.execute(cmd("WIN", "25.00"), opts);
  await submit.execute(cmd("REFUND", "10.00", { referenceExternalTransactionId: "b1" }), opts);
  expect(uow.ledgerBalance(wallet.walletId)).toBe(await balance());
});
