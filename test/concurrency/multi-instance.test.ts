import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { newId } from "../../src/shared/ids";
import { expectLedgerConsistent, migrateFresh, sql } from "../support/db";
import { testConfig } from "../support/env";
import {
  type Harness,
  createHarness,
  drainQueue,
  eventually,
  queueDepth,
  sendToQueue,
  wager,
  wagerMessage,
} from "../support/harness";
import { Instance, freePorts } from "../support/instances";

/**
 * Real parallelism: three separate OS processes (src/main.ts), each with its
 * own connection pool, HTTP server, SQS consumer, outbox relay and
 * pending-reference worker, against one PostgreSQL and one SQS.
 */
let h: Harness;
let instances: Instance[] = [];
const config = testConfig({ sqs: { visibilityTimeoutSec: 3 } }, "multi");

beforeAll(async () => {
  h = await createHarness(config);
  await migrateFresh(h.orm);
  const ports = freePorts(3);
  instances = await Promise.all(ports.map((port, i) => Instance.start(config, port, `inst-${i + 1}`)));
}, 60_000);

afterAll(async () => {
  await Promise.all(instances.map((i) => i.stop("SIGTERM")));
  await h.close();
});

const pick = (i: number) => instances[i % instances.length]!;

async function openWallet(amount: string) {
  const playerId = newId();
  const res = await pick(Math.floor(Math.random() * 3)).post("/wallets", {
    playerId,
    initialBalance: { amount, currency: "BRL" },
  });
  expect(res.status).toBe(201);
  return { walletId: res.body.id as string, playerId };
}

function submitVia(instance: Instance, cmd: ReturnType<typeof wager>) {
  const { idempotencyKey, ...body } = cmd;
  return instance.post("/wagering/transactions", body, { "Idempotency-Key": idempotencyKey });
}

const debits = async (walletId: string) =>
  (await sql<{ n: number }>(h.orm, `SELECT COUNT(*)::int n FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'`, [walletId]))[0]!.n;

const balanceOf = async (walletId: string) =>
  (await sql<{ b: string }>(h.orm, `SELECT balance_amount::text b FROM wallets WHERE id = ?`, [walletId]))[0]!.b;

describe("concurrency across 3 instances", () => {
  test("1. the same bet sent 50× in parallel → exactly one debit", async () => {
    const w = await openWallet("1000.00");
    const cmd = wager(w, "BET", "25.00", `same-${newId()}`);
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => submitVia(pick(i), cmd)));

    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 200)).toHaveLength(49);
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    expect(results.every((r) => r.body.balance.amount === "975.00")).toBe(true);
    expect(await debits(w.walletId)).toBe(1);
    expect(await balanceOf(w.walletId)).toBe("975.00");
  });

  test("2. section 8: 100.00 balance, two 80.00 bets at the same time (repeated 10×)", async () => {
    for (let round = 0; round < 10; round++) {
      const w = await openWallet("100.00");
      const [a, b] = await Promise.all([
        submitVia(pick(round), wager(w, "BET", "80.00")),
        submitVia(pick(round + 1), wager(w, "BET", "80.00")),
      ]);
      const outcomes = [a.body.status, b.body.status].sort();
      expect(outcomes).toEqual(["PROCESSED", "REJECTED"]);
      const rejected = a.body.status === "REJECTED" ? a : b;
      expect(rejected.status).toBe(422);
      expect(rejected.body.failureCode).toBe("INSUFFICIENT_FUNDS");
      expect(await balanceOf(w.walletId)).toBe("20.00");
      expect(await debits(w.walletId)).toBe(1);
    }
  });

  test("3. distinct wallets are processed in parallel without interference", async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, () => openWallet("500.00")));
    const started = performance.now();
    await Promise.all(
      wallets.flatMap((w, wi) =>
        Array.from({ length: 10 }, (_, j) => submitVia(pick(wi + j), wager(w, "BET", "3.33"))),
      ),
    );
    const elapsed = performance.now() - started;
    for (const w of wallets) {
      expect(await balanceOf(w.walletId)).toBe("466.70");
      expect(await debits(w.walletId)).toBe(10);
    }
    expect(elapsed).toBeLessThan(30_000);
  });

  test("4. hot wallet hammered through HTTP and SQS on 3 instances never goes negative", async () => {
    const w = await openWallet("500.00");
    const http = Array.from({ length: 50 }, (_, i) => submitVia(pick(i), wager(w, "BET", "7.00")));
    for (let i = 0; i < 50; i++) {
      await sendToQueue(h, wagerMessage(wager(w, "BET", "7.00")), w.walletId);
    }
    await Promise.all(http);
    await eventually(
      async () => {
        const n = (await sql<{ n: number }>(h.orm, `SELECT COUNT(*)::int n FROM wager_transactions WHERE wallet_id = ? AND kind = 'BET'`, [w.walletId]))[0]!.n;
        return n === 100;
      },
      { timeoutMs: 60_000, message: "not all 100 bets were processed" },
    );
    // 500 / 7 = 71 bets fit (497.00), 29 are rejected, 3.00 left.
    const rows = await sql<{ status: string; n: number }>(
      h.orm,
      `SELECT status, COUNT(*)::int n FROM wager_transactions WHERE wallet_id = ? AND kind = 'BET' GROUP BY status`,
      [w.walletId],
    );
    expect(Object.fromEntries(rows.map((r) => [r.status, r.n]))).toEqual({ PROCESSED: 71, REJECTED: 29 });
    expect(await balanceOf(w.walletId)).toBe("3.00");
    expect(await debits(w.walletId)).toBe(71);
  }, 90_000);

  test("7. REFUND delivered before its BET (SQS) is parked and resolved by any instance", async () => {
    const w = await openWallet("100.00");
    const betId = `bet-${newId()}`;
    await sendToQueue(h, wagerMessage(wager(w, "REFUND", "40.00", undefined, { referenceExternalTransactionId: betId })), w.walletId);
    await sendToQueue(h, wagerMessage(wager(w, "BET", "40.00", betId)), w.walletId);
    await eventually(
      async () => {
        const rows = await sql<{ kind: string; status: string }>(
          h.orm,
          `SELECT kind, status FROM wager_transactions WHERE wallet_id = ? AND kind IN ('BET','REFUND')`,
          [w.walletId],
        );
        return rows.length === 2 && rows.every((r) => r.status === "PROCESSED");
      },
      { timeoutMs: 30_000, message: "REFUND was not resolved" },
    );
    expect(await balanceOf(w.walletId)).toBe("100.00");
  });

  test("6. every committed event is eventually published by the concurrent relays", async () => {
    await eventually(
      async () => (await sql<{ n: number }>(h.orm, `SELECT COUNT(*)::int n FROM outbox_messages WHERE published_at IS NULL`))[0]!.n === 0,
      { timeoutMs: 30_000, message: "outbox not drained" },
    );
    const total = (await sql<{ n: number }>(h.orm, `SELECT COUNT(*)::int n FROM outbox_messages`))[0]!.n;
    const received = await drainQueue(h, h.sqs.queues.events);
    const ids = new Set(received.map((m) => JSON.parse(m.Body!).eventId));
    expect(ids.size).toBe(total);
  }, 60_000);

  test("final invariant: wallet.balance == ledger for every wallet", async () => {
    const audits = await expectLedgerConsistent(h.orm);
    expect(audits.length).toBeGreaterThan(30);
  });
});

describe("crash recovery", () => {
  test("5. worker killed after commit and before ack → redelivery is absorbed by the inbox", async () => {
    // Dedicated queues so only the chaos instance can take the message.
    const crashConfig = testConfig({ sqs: { visibilityTimeoutSec: 2 }, workers: { outboxEnabled: false } }, "crash");
    const ch = await createHarness(crashConfig);
    try {
      const [p1, p2] = freePorts(2);
      const chaos = await Instance.start(crashConfig, p1!, "chaos", { CHAOS_CRASH_AFTER_COMMIT_BEFORE_ACK: "true" });
      const w = await openWallet("100.00");
      await sendToQueue(ch, wagerMessage(wager(w, "BET", "30.00"), "crash-msg-1"), w.walletId);

      expect(await chaos.proc.exited).toBe(137); // died right after COMMIT, before DeleteMessage
      expect(await balanceOf(w.walletId)).toBe("70.00"); // the effect is committed…
      const depth = await queueDepth(ch, ch.sqs.queues.input);
      expect(depth.visible + depth.inFlight).toBe(1); // …but the message was never acked

      const survivor = await Instance.start(crashConfig, p2!, "survivor");
      try {
        await eventually(
          async () => {
            const d = await queueDepth(ch, ch.sqs.queues.input);
            return d.visible === 0 && d.inFlight === 0;
          },
          { timeoutMs: 20_000, message: "redelivered message was not acked" },
        );
        expect(await balanceOf(w.walletId)).toBe("70.00");
        expect(await debits(w.walletId)).toBe(1);
        const metrics = await (await fetch(`${survivor.url}/metrics`)).text();
        expect(metrics).toMatch(/wagering_duplicates_total\{type="inbox_message",source="sqs"\} 1/);
      } finally {
        await survivor.stop();
      }
    } finally {
      await ch.close();
    }
  }, 60_000);

  test("8. all instances SIGKILLed mid-load, restarted → consistent final state, nothing lost or doubled", async () => {
    const w = await Promise.all(Array.from({ length: 5 }, () => openWallet("1000.00")));
    const sent: string[] = [];
    for (let i = 0; i < 60; i++) {
      const wallet = w[i % w.length]!;
      const cmd = wager(wallet, "BET", "1.50");
      sent.push(cmd.externalTransactionId);
      await sendToQueue(h, wagerMessage(cmd), wallet.walletId);
    }
    const inflightHttp = Array.from({ length: 30 }, (_, i) =>
      submitVia(pick(i), wager(w[i % w.length]!, "BET", "2.00")).catch(() => undefined),
    );
    await Bun.sleep(300);
    await Promise.all(instances.map((i) => i.stop("SIGKILL")));
    await Promise.all(inflightHttp);

    const ports = freePorts(3);
    instances = await Promise.all(ports.map((port, i) => Instance.start(config, port, `restarted-${i + 1}`)));

    // Every queued message ends up processed exactly once.
    await eventually(
      async () => {
        const rows = await sql<{ n: number }>(
          h.orm,
          `SELECT COUNT(*)::int n FROM wager_transactions WHERE external_transaction_id IN (${sent.map(() => "?").join(",")})`,
          sent,
        );
        return rows[0]!.n === sent.length;
      },
      { timeoutMs: 60_000, message: "queued messages were lost" },
    );
    await eventually(
      async () => {
        const d = await queueDepth(h, h.sqs.queues.input);
        const outbox = (await sql<{ n: number }>(h.orm, `SELECT COUNT(*)::int n FROM outbox_messages WHERE published_at IS NULL`))[0]!.n;
        return d.visible === 0 && d.inFlight === 0 && outbox === 0;
      },
      { timeoutMs: 60_000, message: "system did not settle after restart" },
    );
    const dupes = await sql(h.orm, `SELECT idempotency_key FROM wager_transactions GROUP BY idempotency_key HAVING COUNT(*) > 1`);
    expect(dupes).toHaveLength(0);
    const stuck = await sql(h.orm, `SELECT id FROM wager_transactions WHERE status IN ('PENDING', 'PENDING_REFERENCE')`);
    expect(stuck).toHaveLength(0);
    await expectLedgerConsistent(h.orm);
  }, 150_000);
});
