import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { newId } from "../../src/shared/ids";
import { expectLedgerConsistent, migrateFresh, openOrm, resetData, sql } from "../support/db";
import { testConfig } from "../support/env";
import {
  type Harness,
  createHarness,
  drainQueue,
  eventually,
  openTestWallet,
  queueDepth,
  sendToQueue,
  wager,
  wagerMessage,
} from "../support/harness";
import type { WagerConsumer } from "../../src/interface/sqs/wager-consumer";

let h: Harness;
let consumer: WagerConsumer | undefined;

beforeAll(async () => {
  // Short lock timeout so a held wallet lock produces real, fast transient failures.
  h = await createHarness(testConfig({ db: { lockTimeoutMs: 300, transientRetries: 1 } }, "sqs"));
  await migrateFresh(h.orm);
});
afterAll(() => h.close());
beforeEach(() => resetData(h.orm));
afterEach(async () => {
  await consumer?.stop();
  consumer = undefined;
  await drainQueue(h, h.sqs.queues.input, 1);
  await drainQueue(h, h.sqs.queues.dlq, 1);
});

const txCount = async (walletId: string, status = "PROCESSED") =>
  (await sql<{ n: number }>(h.orm, `SELECT COUNT(*)::int n FROM wager_transactions WHERE wallet_id = ? AND status = ? AND kind <> 'OPENING'`, [walletId, status]))[0]!.n;

describe("SQS consumer", () => {
  test("processes a message through the same use case and acks after commit", async () => {
    const w = await openTestWallet(h);
    await sendToQueue(h, wagerMessage(wager(w, "BET", "25.00")), w.walletId);
    consumer = h.newConsumer();
    consumer.start();
    await eventually(async () => (await txCount(w.walletId)) === 1);
    await eventually(async () => {
      const d = await queueDepth(h, h.sqs.queues.input);
      return d.visible === 0 && d.inFlight === 0;
    }, { message: "message was not acked" });
    expect((await h.queries.wallet(w.walletId)).balance.formatAmount()).toBe("75.00");
    await expectLedgerConsistent(h.orm);
  });

  test("redelivery of the same messageId is deduplicated by the inbox (one debit)", async () => {
    const w = await openTestWallet(h);
    const message = wagerMessage(wager(w, "BET", "10.00"), "msg-dup-1");
    // Different SQS dedup ids: the broker delivers all three; the inbox must absorb them.
    for (let i = 0; i < 3; i++) await sendToQueue(h, message, w.walletId);
    consumer = h.newConsumer();
    consumer.start();
    await eventually(async () => {
      const d = await queueDepth(h, h.sqs.queues.input);
      return d.visible === 0 && d.inFlight === 0;
    });
    expect(await txCount(w.walletId)).toBe(1);
    expect((await h.queries.wallet(w.walletId)).balance.formatAmount()).toBe("90.00");
    const duplicates = (await h.metrics.registry.getSingleMetricAsString("wagering_duplicates_total"));
    expect(duplicates).toContain('type="inbox_message"');
    await expectLedgerConsistent(h.orm);
  });

  test("business rejection is terminal: persisted and acked (not retried, not DLQ)", async () => {
    const w = await openTestWallet(h, "5.00");
    await sendToQueue(h, wagerMessage(wager(w, "BET", "6.00")), w.walletId);
    consumer = h.newConsumer();
    consumer.start();
    await eventually(async () => (await txCount(w.walletId, "REJECTED")) === 1);
    await eventually(async () => (await queueDepth(h, h.sqs.queues.input)).inFlight === 0);
    expect((await queueDepth(h, h.sqs.queues.dlq)).visible).toBe(0);
  });

  test("malformed and permanently invalid messages go straight to the DLQ", async () => {
    const w = await openTestWallet(h);
    await sendToQueue(h, "{this is not json", "g1");
    await sendToQueue(h, { ...wagerMessage(wager(w, "OPENING", "1.00")) }, "g2");
    await sendToQueue(h, wagerMessage(wager({ walletId: newId(), playerId: "x" }, "BET", "1.00")), "g3"); // unknown wallet
    consumer = h.newConsumer();
    consumer.start();
    const dead = await eventually(async () => {
      const d = await queueDepth(h, h.sqs.queues.dlq);
      return d.visible >= 3 ? d : undefined;
    });
    expect(dead.visible).toBe(3);
    const messages = await drainQueue(h, h.sqs.queues.dlq);
    const codes = messages.map((m) => m.MessageAttributes?.errorCode?.StringValue).sort();
    expect(codes).toEqual(["VALIDATION_ERROR", "VALIDATION_ERROR", "WALLET_NOT_FOUND"]);
    expect(new Set(messages.map((m) => m.MessageAttributes?.failureReason?.StringValue))).toEqual(
      new Set(["MALFORMED_MESSAGE", "PERMANENT_ERROR"]),
    );
  });

  test("transient failure (wallet lock held) is retried with backoff and then succeeds", async () => {
    const w = await openTestWallet(h);
    // Hold the wallet row lock from another connection → real LOCK_TIMEOUT for the consumer.
    const blocker = await openOrm(undefined, 1);
    const em = blocker.em.fork();
    await em.begin();
    await em.execute(`SELECT id FROM wallets WHERE id = ? FOR UPDATE`, [w.walletId]);
    try {
      await sendToQueue(h, wagerMessage(wager(w, "BET", "10.00")), w.walletId);
      consumer = h.newConsumer();
      consumer.start();
      await eventually(async () => (await h.metrics.registry.getSingleMetricAsString("sqs_messages_total")).includes('outcome="retried"'), {
        message: "no retry happened",
      });
    } finally {
      await em.rollback();
      await blocker.close(true);
    }
    await eventually(async () => (await txCount(w.walletId)) === 1, { timeoutMs: 20_000 });
    expect((await queueDepth(h, h.sqs.queues.dlq)).visible).toBe(0);
    expect((await h.queries.wallet(w.walletId)).balance.formatAmount()).toBe("90.00");
  });

  test("retries are bounded: after maxReceiveCount the message is dead-lettered", async () => {
    const w = await openTestWallet(h);
    const blocker = await openOrm(undefined, 1);
    const em = blocker.em.fork();
    await em.begin();
    await em.execute(`SELECT id FROM wallets WHERE id = ? FOR UPDATE`, [w.walletId]);
    try {
      await sendToQueue(h, wagerMessage(wager(w, "BET", "10.00")), w.walletId);
      consumer = h.newConsumer();
      consumer.start();
      const dlq = await eventually(async () => {
        const d = await queueDepth(h, h.sqs.queues.dlq);
        return d.visible >= 1 ? d : undefined;
      }, { timeoutMs: 30_000, message: "message never reached the DLQ" });
      expect(dlq.visible).toBe(1);
    } finally {
      await em.rollback();
      await blocker.close(true);
    }
    const [dead] = await drainQueue(h, h.sqs.queues.dlq);
    expect(dead!.MessageAttributes?.failureReason?.StringValue).toBe("RETRIES_EXHAUSTED");
    expect(Number(dead!.MessageAttributes?.receiveCount?.StringValue)).toBe(h.config.sqs.maxReceiveCount);
    expect(await txCount(w.walletId)).toBe(0);
    await expectLedgerConsistent(h.orm);
  }, 45_000);

  test("stop() lets in-flight work finish and releases the rest", async () => {
    const w = await openTestWallet(h, "1000.00");
    for (let i = 0; i < 5; i++) await sendToQueue(h, wagerMessage(wager(w, "BET", "1.00")), w.walletId);
    consumer = h.newConsumer();
    consumer.start();
    await eventually(async () => (await txCount(w.walletId)) >= 1);
    await consumer.stop();
    consumer = undefined;
    const processed = await txCount(w.walletId);
    // Whatever was not processed is back in the queue (visible) — nothing is lost or stuck in flight.
    await eventually(async () => {
      const d = await queueDepth(h, h.sqs.queues.input);
      return d.inFlight === 0 && d.visible === 5 - processed;
    }, { message: "unprocessed messages were not released" });
    consumer = h.newConsumer();
    consumer.start();
    await eventually(async () => (await txCount(w.walletId)) === 5);
    await expectLedgerConsistent(h.orm);
  });
});
