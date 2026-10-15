import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { createApp } from "../../src/bootstrap";
import { newId } from "../../src/shared/ids";
import { expectLedgerConsistent, migrateFresh, openOrm } from "../support/db";
import { testConfig } from "../support/env";
import type { MikroORM } from "@mikro-orm/postgresql";

let app: INestApplication;
let base: string;
let orm: MikroORM;

beforeAll(async () => {
  orm = await openOrm();
  await migrateFresh(orm);
  const config = testConfig({ workers: { consumerEnabled: false } }, "http");
  app = await createApp(config);
  await app.listen(0);
  base = await app.getUrl();
  base = base.replace("[::1]", "127.0.0.1");
});
afterAll(async () => {
  await app.close();
  await orm.close(true);
});

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers };
}

async function newWallet(amount = "1000.00") {
  const playerId = newId();
  const res = await call("POST", "/wallets", { playerId, initialBalance: { amount, currency: "BRL" } });
  expect(res.status).toBe(201);
  return { walletId: res.body.id as string, playerId };
}

function bet(w: { walletId: string; playerId: string }, ext: string, amount = "25.00", extra: Record<string, unknown> = {}) {
  return {
    providerId: "provider-a",
    externalTransactionId: ext,
    playerId: w.playerId,
    walletId: w.walletId,
    roundId: "round-987",
    gameId: "fortune-chimp",
    kind: "BET",
    money: { amount, currency: "BRL" },
    ...extra,
  };
}

const submit = (body: Record<string, any>, key = `${body.providerId}:${body.externalTransactionId}`) =>
  call("POST", "/wagering/transactions", body, { "Idempotency-Key": key });

describe("wallets", () => {
  test("create → 201 with balance and version 1; duplicate player+currency → 409", async () => {
    const playerId = newId();
    const res = await call("POST", "/wallets", { playerId, initialBalance: { amount: "1000.00", currency: "BRL" } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ playerId, balance: { amount: "1000.00", currency: "BRL" }, version: 1 });
    const dup = await call("POST", "/wallets", { playerId, initialBalance: { amount: "1.00", currency: "BRL" } });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("WALLET_ALREADY_EXISTS");
  });

  test("invalid money → 400", async () => {
    for (const amount of ["1.001", "-5.00", "1e2", "", "NaN"]) {
      const res = await call("POST", "/wallets", { playerId: newId(), initialBalance: { amount, currency: "BRL" } });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    }
    const numeric = await call("POST", "/wallets", { playerId: newId(), initialBalance: { amount: 10, currency: "BRL" } });
    expect(numeric.status).toBe(400);
  });

  test("get / unknown / malformed id", async () => {
    const w = await newWallet();
    expect((await call("GET", `/wallets/${w.walletId}`)).body.balance.amount).toBe("1000.00");
    expect((await call("GET", `/wallets/${newId()}`)).status).toBe(404);
    expect((await call("GET", `/wallets/not-a-uuid`)).status).toBe(400);
  });

  test("ledger pagination with an opaque, stable cursor", async () => {
    const w = await newWallet();
    for (let i = 0; i < 5; i++) await submit(bet(w, `pg-${w.walletId}-${i}`, "1.00"));
    const seen: number[] = [];
    let cursor: string | null = null;
    do {
      const res: { status: number; body: any } = await call(
        "GET",
        `/wallets/${w.walletId}/ledger?limit=2${cursor ? `&cursor=${cursor}` : ""}`,
      );
      expect(res.status).toBe(200);
      seen.push(...res.body.items.map((i: { walletVersion: number }) => i.walletVersion));
      cursor = res.body.nextCursor;
    } while (cursor);
    expect(seen).toEqual([1, 2, 3, 4, 5, 6]);
    expect((await call("GET", `/wallets/${w.walletId}/ledger?cursor=garbage!`)).status).toBe(400);
  });

  test("reconciliation reports consistency", async () => {
    const w = await newWallet();
    await submit(bet(w, `rc-${w.walletId}`));
    const res = await call("POST", `/wallets/${w.walletId}/reconciliation`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      walletId: w.walletId,
      storedBalance: { amount: "975.00", currency: "BRL" },
      calculatedBalance: { amount: "975.00", currency: "BRL" },
      difference: { amount: "0.00", currency: "BRL" },
      consistent: true,
      checkedEntries: 2,
    });
  });
});

describe("POST /wagering/transactions — status mapping", () => {
  test("201 processed, 200 idempotent replay with identical body", async () => {
    const w = await newWallet();
    const first = await submit(bet(w, `s-${w.walletId}`));
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ status: "PROCESSED", balance: { amount: "975.00", currency: "BRL" }, idempotentReplay: false });
    const replay = await submit(bet(w, `s-${w.walletId}`));
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
  });

  test("409 idempotency conflict (same key, different payload) — not a replay", async () => {
    const w = await newWallet();
    await submit(bet(w, `c-${w.walletId}`));
    const res = await submit(bet(w, `c-${w.walletId}`, "26.00"));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IDEMPOTENCY_KEY_CONFLICT");
    expect(res.body.error.retryable).toBe(false);
  });

  test("422 business rejection carries a failureCode", async () => {
    const w = await newWallet("10.00");
    const res = await submit(bet(w, `r-${w.walletId}`, "10.01"));
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS", balance: { amount: "10.00" } });
  });

  test("202 accepted when the reference is still missing", async () => {
    const w = await newWallet();
    const res = await submit(bet(w, `p-${w.walletId}`, "25.00", { kind: "REFUND", referenceExternalTransactionId: "nope" }));
    expect(res.status).toBe(202);
    expect<string | undefined>(res.body.status).toBe("PENDING_REFERENCE");
  });

  test("400 for missing Idempotency-Key, invalid body, OPENING; 404 unknown wallet", async () => {
    const w = await newWallet();
    const noKey = await call("POST", "/wagering/transactions", bet(w, "x"));
    expect(noKey.status).toBe(400);
    expect((await submit({ ...bet(w, "y"), kind: "OPENING" })).status).toBe(400);
    expect((await submit({ ...bet(w, "z"), money: { amount: 25, currency: "BRL" } })).status).toBe(400);
    expect((await submit({ ...bet(w, "z2"), unexpected: true })).status).toBe(400);
    expect((await call("POST", "/wagering/transactions", "{not json", { "Idempotency-Key": "k" })).status).toBe(400);
    const unknown = await submit(bet({ walletId: newId(), playerId: w.playerId }, `u-${newId()}`));
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe("WALLET_NOT_FOUND");
  });

  test("lookups by internal id and by provider external id", async () => {
    const w = await newWallet();
    const ext = `l-${w.walletId}`;
    const created = await submit(bet(w, ext));
    const byId = await call("GET", `/wagering/transactions/${created.body.transactionId}`);
    expect(byId.body).toMatchObject({ transactionId: created.body.transactionId, kind: "BET", status: "PROCESSED" });
    const byExt = await call("GET", `/providers/provider-a/wagering/transactions/${ext}`);
    expect(byExt.body.transactionId).toBe(created.body.transactionId);
    expect((await call("GET", `/providers/provider-a/wagering/transactions/missing`)).status).toBe(404);
  });
});

describe("ops", () => {
  test("health endpoints are open; readiness checks PostgreSQL and SQS", async () => {
    expect((await call("GET", "/health/live")).body).toEqual({ status: "ok" });
    const ready = await call("GET", "/health/ready");
    expect(ready.status).toBe(200);
    expect(ready.body.checks).toEqual({ postgres: { ok: true }, sqs: { ok: true } });
  });

  test("metrics are exposed in Prometheus format", async () => {
    const res = await fetch(`${base}/metrics`);
    const text = await res.text();
    expect(text).toContain("wagering_transactions_total");
    expect(text).toContain("outbox_lag_seconds");
    expect(text).toContain("wagering_lock_conflicts_total");
  });

  test("correlation id is echoed back", async () => {
    const res = await call("GET", "/health/live", undefined, { "X-Correlation-Id": "abc-123" });
    expect(res.headers.get("x-correlation-id")).toBe("abc-123");
  });

  test("invariant", async () => {
    await expectLedgerConsistent(orm);
  });
});
