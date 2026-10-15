import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { expectLedgerConsistent, migrateFresh, resetData, sql } from "../support/db";
import { testConfig } from "../support/env";
import { type Harness, createHarness, eventually, openTestWallet, wager } from "../support/harness";

let h: Harness;
beforeAll(async () => {
  h = await createHarness(testConfig({}, "pref"));
  await migrateFresh(h.orm);
});
afterAll(() => h.close());
beforeEach(() => resetData(h.orm));

const opts = { source: "http" as const, correlationId: "c" };
const events = async (type: string) =>
  (await sql<{ n: number }>(h.orm, `SELECT COUNT(*)::int n FROM outbox_messages WHERE event_type = ?`, [type]))[0]!.n;

describe("references delivered out of order", () => {
  test("ROLLBACK before its BET: pending, then resolved by the worker", async () => {
    const w = await openTestWallet(h);
    const rollback = await h.submit.execute(wager(w, "ROLLBACK", "30.00", "rb-1", { referenceExternalTransactionId: "bet-1" }), opts);
    expect<string | undefined>(rollback.transaction.status).toBe("PENDING_REFERENCE");
    expect(await events("WagerTransactionPendingReference")).toBe(1);

    await h.submit.execute(wager(w, "BET", "30.00", "bet-1"), opts);
    expect((await h.queries.wallet(w.walletId)).balance.formatAmount()).toBe("70.00");

    // The BET woke the dependent up: it is due now.
    await eventually(async () => (await h.resolver.runOnce(10)).resolved === 1);
    const resolved = await h.queries.transaction(rollback.transaction.id);
    expect<string | undefined>(resolved.status).toBe("PROCESSED");
    expect(resolved.referenceTransactionId).toBeDefined();
    expect((await h.queries.wallet(w.walletId)).balance.formatAmount()).toBe("100.00");
    await expectLedgerConsistent(h.orm);
  });

  test("resubmitting a pending transaction after the reference arrived resolves it inline", async () => {
    const w = await openTestWallet(h);
    const cmd = wager(w, "REFUND", "10.00", "rf-1", { referenceExternalTransactionId: "bet-2" });
    expect<string | undefined>((await h.submit.execute(cmd, opts)).transaction.status).toBe("PENDING_REFERENCE");
    await h.submit.execute(wager(w, "BET", "10.00", "bet-2"), opts);
    const replay = await h.submit.execute(cmd, opts);
    expect(replay.idempotentReplay).toBe(true);
    expect<string | undefined>(replay.transaction.status).toBe("PROCESSED");
    expect(replay.transaction.observedBalance?.formatAmount()).toBe("100.00");
  });

  test("gives up after the attempt limit: REJECTED / REFERENCE_NOT_FOUND + event", async () => {
    const w = await openTestWallet(h);
    const r = await h.submit.execute(wager(w, "REFUND", "10.00", "rf-x", { referenceExternalTransactionId: "never" }), opts);
    await eventually(
      async () => {
        await h.resolver.runOnce(10);
        return (await h.queries.transaction(r.transaction.id)).status === "REJECTED";
      },
      { timeoutMs: 15_000, intervalMs: 50 },
    );
    const tx = await h.queries.transaction(r.transaction.id);
    expect<string | undefined>(tx.failureCode).toBe("REFERENCE_NOT_FOUND");
    expect(tx.referenceAttempts).toBe(h.config.workers.referenceMaxAttempts - 1);
    expect(await events("WagerTransactionRejected")).toBe(1);
    expect((await h.queries.wallet(w.walletId)).balance.formatAmount()).toBe("100.00");
  });

  test("two resolvers racing on the same pending transaction apply it once", async () => {
    const w = await openTestWallet(h);
    await h.submit.execute(wager(w, "REFUND", "20.00", "rf-race", { referenceExternalTransactionId: "bet-race" }), opts);
    await h.submit.execute(wager(w, "BET", "20.00", "bet-race"), opts);
    const reports = await Promise.all([h.resolver.runOnce(10), h.resolver.runOnce(10), h.resolver.runOnce(10)]);
    expect(reports.reduce((n, r) => n + r.resolved, 0)).toBe(1);
    expect((await h.queries.wallet(w.walletId)).balance.formatAmount()).toBe("100.00");
    await expectLedgerConsistent(h.orm);
  });
});
