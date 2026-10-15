import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import type { MikroORM } from "@mikro-orm/postgresql";
import { createApp } from "../../src/bootstrap";
import { newId } from "../../src/shared/ids";
import { migrateFresh, openOrm } from "../support/db";
import { testConfig } from "../support/env";

/** Real Keycloak (docker compose service `keycloak`, realm imported from docker/keycloak). */
let app: INestApplication;
let base: string;
let orm: MikroORM;

beforeAll(async () => {
  orm = await openOrm();
  await migrateFresh(orm);
  const config = testConfig({ workers: { consumerEnabled: false } }, "auth");
  app = await createApp({ ...config, auth: { ...config.auth, enabled: true } });
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "127.0.0.1");
});
afterAll(async () => {
  await app.close();
  await orm.close(true);
});

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers };
}

async function token(clientId: string) {
  const res = await call("POST", "/auth/token", { clientId, clientSecret: `${clientId}-secret` });
  expect(res.status).toBe(200);
  return res.body.access_token as string;
}
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

describe("authentication (Keycloak, client_credentials)", () => {
  test("POST /auth/token returns a bearer token from the IdP", async () => {
    const res = await call("POST", "/auth/token", { clientId: "provider-a", clientSecret: "provider-a-secret" });
    expect(res.status).toBe(200);
    expect(res.body.token_type).toBe("Bearer");
    expect(res.body.expires_in).toBeGreaterThan(0);
    expect(res.body.access_token.split(".")).toHaveLength(3);
  });

  test("HTTP Basic credentials work too; wrong secret → 401", async () => {
    const basic = Buffer.from("provider-b:provider-b-secret").toString("base64");
    expect((await call("POST", "/auth/token", undefined, { Authorization: `Basic ${basic}` })).status).toBe(200);
    const wrong = await call("POST", "/auth/token", { clientId: "provider-a", clientSecret: "nope" });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe("INVALID_CLIENT_CREDENTIALS");
    expect((await call("POST", "/auth/token", { clientId: "provider-a" })).status).toBe(400);
  });

  test("protected routes need a valid bearer token; health and metrics stay open", async () => {
    const missing = await call("GET", `/wallets/${newId()}`);
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toContain("Bearer");
    expect((await call("GET", `/wallets/${newId()}`, undefined, bearer("garbage.token.value"))).status).toBe(401);
    expect((await call("GET", "/health/live")).status).toBe(200);
    expect((await call("GET", "/health/ready")).status).toBe(200);
    expect((await fetch(`${base}/metrics`)).status).toBe(200);
  });

  test("a provider can only act for its own providerId", async () => {
    const a = await token("provider-a");
    const playerId = newId();
    const wallet = await call("POST", "/wallets", { playerId, initialBalance: { amount: "100.00", currency: "BRL" } }, bearer(a));
    expect(wallet.status).toBe(201);

    const bet = (providerId: string, ext: string) => ({
      providerId,
      externalTransactionId: ext,
      playerId,
      walletId: wallet.body.id,
      roundId: "r1",
      gameId: "g",
      kind: "BET",
      money: { amount: "10.00", currency: "BRL" },
    });
    const own = await call("POST", "/wagering/transactions", bet("provider-a", "a-1"), { ...bearer(a), "Idempotency-Key": "provider-a:a-1" });
    expect(own.status).toBe(201);

    const impersonation = await call("POST", "/wagering/transactions", bet("provider-b", "b-1"), {
      ...bearer(a),
      "Idempotency-Key": "provider-b:b-1",
    });
    expect(impersonation.status).toBe(403);

    const b = await token("provider-b");
    expect((await call("GET", `/wagering/transactions/${own.body.transactionId}`, undefined, bearer(b))).status).toBe(403);
    expect((await call("GET", `/providers/provider-a/wagering/transactions/a-1`, undefined, bearer(b))).status).toBe(403);
    expect((await call("GET", `/providers/provider-a/wagering/transactions/a-1`, undefined, bearer(a))).status).toBe(200);
  });

  test("reconciliation requires the operator role", async () => {
    const a = await token("provider-a");
    const wallet = await call("POST", "/wallets", { playerId: newId(), initialBalance: { amount: "5.00", currency: "BRL" } }, bearer(a));
    const path = `/wallets/${wallet.body.id}/reconciliation`;
    expect((await call("POST", path, undefined, bearer(a))).status).toBe(403);
    const ops = await call("POST", path, undefined, bearer(await token("backoffice")));
    expect(ops.status).toBe(200);
    expect(ops.body.consistent).toBe(true);
  });
});
