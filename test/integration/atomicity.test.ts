import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { MikroOrmUnitOfWork } from "../../src/infrastructure/persistence/mikro-orm-unit-of-work";
import { systemClock } from "../../src/application/ports/clock";
import { noopMetrics } from "../../src/application/ports/metrics";
import { SubmitWagerTransaction } from "../../src/application/use-cases/submit-wager-transaction";
import { WagerDecisionService } from "../../src/application/wager-decision";
import type { WageringStore } from "../../src/application/ports/repositories";
import { expectLedgerConsistent, migrateFresh, resetData, sql } from "../support/db";
import { testConfig } from "../support/env";
import { type Harness, createHarness, openTestWallet, wager } from "../support/harness";

let h: Harness;
beforeAll(async () => {
  h = await createHarness(testConfig({}, "atom"));
  await migrateFresh(h.orm);
});
afterAll(() => h.close());
beforeEach(() => resetData(h.orm));

const count = async (table: string) => (await sql<{ n: number }>(h.orm, `SELECT COUNT(*)::int AS n FROM ${table}`))[0]!.n;

describe("atomicity: wallet + transaction + ledger + inbox + outbox", () => {
  test("wallet opening writes wallet, OPENING transaction, CREDIT line and events together", async () => {
    await openTestWallet(h, "1000.00");
    expect(await count("wallets")).toBe(1);
    expect(await count("wager_transactions")).toBe(1);
    expect(await count("wallet_ledger_entries")).toBe(1);
    expect(await count("outbox_messages")).toBe(2);
  });

  test("a processed SQS-sourced bet commits all five writes", async () => {
    const w = await openTestWallet(h);
    const r = await h.submit.execute(wager(w, "BET", "25.00"), {
      source: "sqs",
      correlationId: "c",
      inbox: { consumerName: "wagering-processor", messageId: "msg-1", payloadHash: "h" },
    });
    expect<string | undefined>(r.transaction.status).toBe("PROCESSED");
    const [inbox] = await sql<{ transaction_id: string; processed_at: Date }>(h.orm, `SELECT * FROM inbox_messages`);
    expect(inbox!.transaction_id).toBe(r.transaction.id);
    expect(inbox!.processed_at).toBeTruthy();
    expect(await count("wallet_ledger_entries")).toBe(2);
    const events = await sql<{ event_type: string }>(h.orm, `SELECT event_type FROM outbox_messages ORDER BY occurred_at, event_type`);
    expect(events.map((e) => e.event_type)).toContain("WalletBalanceChanged");
    await expectLedgerConsistent(h.orm);
  });

  test("a failure after the writes rolls back everything (nothing half-applied)", async () => {
    const w = await openTestWallet(h);
    const before = {
      tx: await count("wager_transactions"),
      ledger: await count("wallet_ledger_entries"),
      outbox: await count("outbox_messages"),
      inbox: await count("inbox_messages"),
    };
    // Same wiring, but the outbox write blows up — as if the process failed mid-transaction.
    const real = new MikroOrmUnitOfWork(h.orm, { lockTimeoutMs: 5000, statementTimeoutMs: 10000 });
    const failingUow = {
      transactional: <T>(work: (s: WageringStore) => Promise<T>) =>
        real.transactional((store) =>
          work({
            ...store,
            outbox: {
              add: async () => {
                throw new Error("boom: outbox unavailable");
              },
            },
          }),
        ),
      read: real.read.bind(real),
    };
    const submit = new SubmitWagerTransaction(
      failingUow,
      new WagerDecisionService({ baseDelayMs: 100, maxDelayMs: 100, maxAttempts: 3 }),
      systemClock,
      noopMetrics,
      1,
    );
    await expect(
      submit.execute(wager(w, "BET", "25.00"), {
        source: "sqs",
        correlationId: "c",
        inbox: { consumerName: "c", messageId: "m-boom", payloadHash: "h" },
      }),
    ).rejects.toThrow(/boom/);

    expect(await count("wager_transactions")).toBe(before.tx);
    expect(await count("wallet_ledger_entries")).toBe(before.ledger);
    expect(await count("outbox_messages")).toBe(before.outbox);
    expect(await count("inbox_messages")).toBe(before.inbox);
    const wallet = await h.queries.wallet(w.walletId);
    expect(wallet.balance.formatAmount()).toBe("100.00");
    expect(wallet.version).toBe(1);
  });

  test("a rejected transaction is persisted for audit, without ledger or balance change", async () => {
    const w = await openTestWallet(h, "10.00");
    const r = await h.submit.execute(wager(w, "BET", "10.01"), { source: "http", correlationId: "c" });
    expect<string | undefined>(r.transaction.status).toBe("REJECTED");
    const stored = await h.queries.transaction(r.transaction.id);
    expect<string | undefined>(stored.failureCode).toBe("INSUFFICIENT_FUNDS");
    expect(await count("wallet_ledger_entries")).toBe(1);
    await expectLedgerConsistent(h.orm);
  });
});
