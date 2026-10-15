import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { SqsGateway } from "../../src/infrastructure/sqs/sqs-gateway";
import { OutboxPublisher } from "../../src/infrastructure/sqs/outbox-publisher";
import { migrateFresh, resetData, sql } from "../support/db";
import { testConfig } from "../support/env";
import { type Harness, createHarness, drainQueue, openTestWallet, quietLogger, wager } from "../support/harness";

let h: Harness;
beforeAll(async () => {
  h = await createHarness(testConfig({}, "outbox"));
  await migrateFresh(h.orm);
});
afterAll(() => h.close());
beforeEach(async () => {
  await resetData(h.orm);
  await drainQueue(h, h.sqs.queues.events, 1);
});

async function produceEvents(wallets: number, betsPerWallet: number): Promise<number> {
  for (let i = 0; i < wallets; i++) {
    const w = await openTestWallet(h, "1000.00");
    for (let j = 0; j < betsPerWallet; j++) {
      await h.submit.execute(wager(w, "BET", "1.00"), { source: "http", correlationId: "c" });
    }
  }
  return (await sql<{ n: number }>(h.orm, `SELECT COUNT(*)::int n FROM outbox_messages`))[0]!.n;
}

const pending = async () =>
  (await sql<{ n: number }>(h.orm, `SELECT COUNT(*)::int n FROM outbox_messages WHERE published_at IS NULL`))[0]!.n;

describe("transactional outbox", () => {
  test("events are only in the outbox after commit; the relay publishes them with envelope intact", async () => {
    const total = await produceEvents(1, 1); // opening (2 events) + bet (2 events)
    expect(total).toBe(4);
    const report = await h.newPublisher("p1").publishBatch();
    expect(report.published).toBe(4);
    expect(await pending()).toBe(0);
    const received = await drainQueue(h, h.sqs.queues.events);
    expect(received).toHaveLength(4);
    const bodies = received.map((m) => JSON.parse(m.Body!));
    for (const b of bodies) {
      // (explicit checks: Bun's toMatchObject + expect.any() mutates the received object)
      for (const field of ["eventId", "eventType", "aggregateId", "correlationId", "occurredAt"]) {
        expect(typeof b[field]).toBe("string");
      }
      expect(b.version).toBe(1);
    }
    const balanceChanged = bodies.find((b) => b.eventType === "WalletBalanceChanged" && b.data.direction === "DEBIT");
    expect(balanceChanged.data.money).toEqual({ amount: "1.00", currency: "BRL" });
  });

  test("concurrent publishers never claim the same row and publish everything", async () => {
    const total = await produceEvents(6, 4);
    const publishers = ["a", "b", "c"].map((id) => h.newPublisher(id, 30_000, 5));
    const claimedBy = new Map<string, number>();
    // Run the three relays concurrently until the outbox is empty.
    await Promise.all(
      publishers.map(async (p, i) => {
        for (;;) {
          const r = await p.publishBatch();
          claimedBy.set(String(i), (claimedBy.get(String(i)) ?? 0) + r.claimed);
          if (r.claimed === 0) break;
        }
      }),
    );
    expect(await pending()).toBe(0);
    const totalClaims = [...claimedBy.values()].reduce((a, b) => a + b, 0);
    expect(totalClaims).toBe(total); // SKIP LOCKED: no row claimed twice
    expect([...claimedBy.values()].filter((n) => n > 0).length).toBeGreaterThan(1);
    const received = await drainQueue(h, h.sqs.queues.events);
    expect(new Set(received.map((m) => JSON.parse(m.Body!).eventId)).size).toBe(total);
  });

  test("publisher dies after publishing but before marking → lease expires → re-published with the same eventId", async () => {
    await produceEvents(1, 0); // 2 events
    // Simulate the crash: claim + send, never mark (lease of 200ms).
    const crashed = h.newPublisher("crashed", 200);
    const claimed = await (crashed as unknown as { claim(): Promise<{ id: string }[]> }).claim();
    await (crashed as unknown as { send(rows: unknown[]): Promise<unknown> }).send(claimed);
    expect(await pending()).toBe(2);

    // While the lease is valid nobody else takes it…
    expect((await h.newPublisher("other").publishBatch()).claimed).toBe(0);
    await Bun.sleep(300);
    // …after it expires another instance publishes again.
    const report = await h.newPublisher("other").publishBatch();
    expect(report.published).toBe(2);
    expect(await pending()).toBe(0);

    const received = await drainQueue(h, h.sqs.queues.events);
    const ids = received.map((m) => JSON.parse(m.Body!).eventId as string);
    // The broker may or may not drop the copy (FIFO dedup window); either way every copy carries
    // the same eventId so consumers de-duplicate. What matters: nothing lost, ids stable.
    expect(new Set(ids)).toEqual(new Set(claimed.map((r) => r.id)));
  });

  test("broker failure → attempts++ with backoff, nothing lost", async () => {
    await produceEvents(1, 0);
    const broken = new SqsGateway({ ...h.config.sqs, autoCreateQueues: false });
    (broken as unknown as { urls: unknown }).urls = {
      ...h.sqs.queues,
      events: `${h.config.sqs.endpoint}/000000000000/does-not-exist.fifo`,
    };
    const publisher = new OutboxPublisher(h.orm, broken, { instanceId: "broken", batchSize: 10, leaseMs: 30_000 }, h.metrics, quietLogger);
    const report = await publisher.publishBatch();
    expect(report.failed).toBe(2);
    const rows = await sql<{ attempts: number; next_attempt_at: Date; last_error: string; locked_until: Date | null }>(
      h.orm,
      `SELECT attempts, next_attempt_at, last_error, locked_until FROM outbox_messages`,
    );
    for (const r of rows) {
      expect(r.attempts).toBe(1);
      expect(new Date(r.next_attempt_at).getTime()).toBeGreaterThan(Date.now());
      expect(r.last_error).toBeTruthy();
      expect(r.locked_until).toBeNull();
    }
    // Not due yet → not claimed again immediately.
    expect((await h.newPublisher("p").publishBatch()).claimed).toBe(0);
    await sql(h.orm, `UPDATE outbox_messages SET next_attempt_at = now()`);
    expect((await h.newPublisher("p").publishBatch()).published).toBe(2);
    broken.client.destroy();
  });

  test("lag metric reflects unpublished messages", async () => {
    await produceEvents(1, 1);
    const p = h.newPublisher("m");
    await p.refreshLagMetrics();
    expect((await h.metrics.outboxPending.get()).values[0]!.value).toBe(4);
    await p.publishBatch();
    expect((await h.metrics.outboxPending.get()).values[0]!.value).toBe(0);
  });
});
