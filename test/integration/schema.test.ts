import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import { newId } from "../../src/shared/ids";
import { migrateFresh, openOrm, resetData, sql } from "../support/db";

/**
 * The invariants hold in the schema itself: these tests write raw SQL,
 * bypassing the application, and expect PostgreSQL to refuse.
 */
let orm: MikroORM;

beforeAll(async () => {
  orm = await openOrm();
  await migrateFresh(orm);
});
afterAll(() => orm.close(true));
beforeEach(() => resetData(orm));

async function tx(statements: string[]): Promise<void> {
  await orm.em.fork().transactional(async (em) => {
    for (const s of statements) await em.execute(s);
  });
}

const now = "now()";
function walletSql(id: string, player: string, balance = "0.00", version = 1) {
  return `INSERT INTO wallets VALUES ('${id}', '${player}', 'BRL', ${balance}, ${version}, ${now}, ${now})`;
}
function txSql(id: string, walletId: string, extra: Partial<Record<string, string>> = {}) {
  const c = {
    provider: "'prov'",
    ext: `'${id}'`,
    key: `'prov:${id}'`,
    kind: "'BET'",
    amount: "10.00",
    status: "'PROCESSED'",
    failure: "NULL",
    refExt: "NULL",
    refId: "NULL",
    processed: now,
    ...extra,
  };
  return `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
            round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id, status, failure_code,
            correlation_id, created_at, processed_at)
          VALUES ('${id}', ${c.provider}, ${c.ext}, ${c.key}, 'h', '${walletId}', 'p', 'r', 'g', ${c.kind}, ${c.amount}, 'BRL', ${c.refExt},
            ${c.refId}, ${c.status}, ${c.failure}, 'c', ${now}, ${c.processed})`;
}
function ledgerSql(walletId: string, txId: string, dir: string, amount: string, before: string, after: string, version: number) {
  return `INSERT INTO wallet_ledger_entries VALUES ('${newId()}', '${walletId}', '${txId}', '${dir}', ${amount}, 'BRL', ${before}, ${after}, ${version}, ${now})`;
}

/** A wallet opened with 100.00 and its OPENING line, built by hand. */
async function seedWallet(): Promise<{ walletId: string; openingId: string }> {
  const walletId = newId();
  const openingId = newId();
  await tx([
    walletSql(walletId, `p-${walletId}`, "100.00", 1),
    txSql(openingId, walletId, { provider: "'__internal__'", kind: "'OPENING'", amount: "100.00" }),
    ledgerSql(walletId, openingId, "CREDIT", "100.00", "0", "100.00", 1),
  ]);
  return { walletId, openingId };
}

describe("migrations", () => {
  test("are reversible: down then up again", async () => {
    const migrator = orm.getMigrator();
    await migrator.down();
    const [row] = await sql<{ count: number }>(
      orm,
      `SELECT COUNT(*)::int AS count FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'wallets'`,
    );
    expect(row!.count).toBe(0);
    await migrator.up();
    expect((await migrator.getPendingMigrations()).length).toBe(0);
  });
});

describe("wallets", () => {
  test("balance can never be negative (CHECK)", async () => {
    const { walletId } = await seedWallet();
    const t = newId();
    await expect(
      tx([
        `UPDATE wallets SET balance_amount = -0.01, version = 2 WHERE id = '${walletId}'`,
        txSql(t, walletId),
        ledgerSql(walletId, t, "DEBIT", "100.01", "100.00", "-0.01", 2),
      ]),
    ).rejects.toThrow(/wallets_balance_non_negative_ck|check/);
  });

  test("one wallet per player + currency", async () => {
    await tx([walletSql(newId(), "same")]);
    await expect(tx([walletSql(newId(), "same")])).rejects.toThrow(/wallets_player_currency_uq/);
  });

  test("balance change requires exactly version + 1", async () => {
    const { walletId } = await seedWallet();
    await expect(tx([`UPDATE wallets SET balance_amount = 50 WHERE id = '${walletId}'`])).rejects.toThrow(/version bump/);
    await expect(tx([`UPDATE wallets SET version = 5 WHERE id = '${walletId}'`])).rejects.toThrow(/without balance change/);
  });

  test("balance cannot change without a matching ledger line (checked at COMMIT)", async () => {
    const { walletId } = await seedWallet();
    await expect(tx([`UPDATE wallets SET balance_amount = 50, version = 2 WHERE id = '${walletId}'`])).rejects.toThrow(
      /no matching ledger line/,
    );
  });

  test("a balance change with its ledger line commits", async () => {
    const { walletId } = await seedWallet();
    const t = newId();
    await tx([
      txSql(t, walletId),
      `UPDATE wallets SET balance_amount = 90, version = 2 WHERE id = '${walletId}'`,
      ledgerSql(walletId, t, "DEBIT", "10.00", "100.00", "90.00", 2),
    ]);
  });

  test("wallets cannot be deleted", async () => {
    const { walletId } = await seedWallet();
    await expect(tx([`DELETE FROM wallets WHERE id = '${walletId}'`])).rejects.toThrow(/cannot be deleted/);
  });
});

describe("ledger", () => {
  test("is append-only: UPDATE, DELETE and TRUNCATE are refused", async () => {
    await seedWallet();
    await expect(tx([`UPDATE wallet_ledger_entries SET amount = 1`])).rejects.toThrow(/append-only/);
    await expect(tx([`DELETE FROM wallet_ledger_entries`])).rejects.toThrow(/append-only/);
    await expect(tx([`TRUNCATE wallet_ledger_entries CASCADE`])).rejects.toThrow(/append-only/);
  });

  test("lines must be arithmetically balanced", async () => {
    const { walletId } = await seedWallet();
    const t = newId();
    await expect(
      tx([
        txSql(t, walletId),
        `UPDATE wallets SET balance_amount = 95, version = 2 WHERE id = '${walletId}'`,
        ledgerSql(walletId, t, "DEBIT", "10.00", "100.00", "95.00", 2),
      ]),
    ).rejects.toThrow(/ledger_balanced_ck/);
  });

  test("lines must chain (balance_before = previous balance_after)", async () => {
    const { walletId } = await seedWallet();
    const t = newId();
    await expect(
      tx([
        txSql(t, walletId),
        `UPDATE wallets SET balance_amount = 40, version = 2 WHERE id = '${walletId}'`,
        ledgerSql(walletId, t, "DEBIT", "10.00", "50.00", "40.00", 2),
      ]),
    ).rejects.toThrow(/chain broken/);
  });

  test("at most one line per (transaction, wallet)", async () => {
    const { walletId } = await seedWallet();
    const t = newId();
    await expect(
      tx([
        txSql(t, walletId),
        `UPDATE wallets SET balance_amount = 80, version = 3 WHERE id = '${walletId}'`,
        ledgerSql(walletId, t, "DEBIT", "10.00", "100.00", "90.00", 2),
        ledgerSql(walletId, t, "DEBIT", "10.00", "90.00", "80.00", 3),
      ]),
    ).rejects.toThrow(/ledger_transaction_wallet_uq|version bump/);
  });

  test("a line cannot be ahead of its wallet (no line without balance change)", async () => {
    const { walletId } = await seedWallet();
    const t = newId();
    await expect(tx([txSql(t, walletId), ledgerSql(walletId, t, "DEBIT", "10.00", "100.00", "90.00", 2)])).rejects.toThrow(
      /no matching wallet version/,
    );
  });
});

describe("wager transactions", () => {
  test("idempotency key and (provider, external id) are unique", async () => {
    const { walletId } = await seedWallet();
    await tx([txSql(newId(), walletId, { key: "'k1'", ext: "'e1'", status: "'PENDING'", processed: "NULL" })]);
    await expect(
      tx([txSql(newId(), walletId, { key: "'k1'", ext: "'e2'", status: "'PENDING'", processed: "NULL" })]),
    ).rejects.toThrow(/wager_tx_idempotency_key_uq/);
    await expect(
      tx([txSql(newId(), walletId, { key: "'k2'", ext: "'e1'", status: "'PENDING'", processed: "NULL" })]),
    ).rejects.toThrow(/wager_tx_provider_external_uq/);
  });

  test("REFUND / ROLLBACK need a reference; OPENING is internal only", async () => {
    const { walletId } = await seedWallet();
    await expect(tx([txSql(newId(), walletId, { kind: "'REFUND'" })])).rejects.toThrow(/wager_tx_reference_required_ck/);
    await expect(tx([txSql(newId(), walletId, { kind: "'OPENING'" })])).rejects.toThrow(/wager_tx_opening_internal_ck/);
  });

  test("REJECTED needs a failure code", async () => {
    const { walletId } = await seedWallet();
    await expect(tx([txSql(newId(), walletId, { status: "'REJECTED'" })])).rejects.toThrow(/wager_tx_failure_code_ck/);
  });

  test("terminal transactions are frozen; business columns immutable; no delete", async () => {
    const { walletId, openingId } = await seedWallet();
    await expect(tx([`UPDATE wager_transactions SET status = 'REJECTED', failure_code = 'X' WHERE id = '${openingId}'`])).rejects.toThrow(
      /terminal/,
    );
    const pending = newId();
    await tx([txSql(pending, walletId, { status: "'PENDING'", processed: "NULL" })]);
    await expect(tx([`UPDATE wager_transactions SET amount = 99 WHERE id = '${pending}'`])).rejects.toThrow(/immutable/);
    await expect(tx([`DELETE FROM wager_transactions WHERE id = '${pending}'`])).rejects.toThrow(/cannot be deleted/);
  });

  test("a transaction can be reverted only once", async () => {
    const { walletId, openingId } = await seedWallet();
    const bet = newId();
    const r1 = newId();
    const r2 = newId();
    await tx([
      txSql(bet, walletId),
      `UPDATE wallets SET balance_amount = 90, version = 2 WHERE id = '${walletId}'`,
      ledgerSql(walletId, bet, "DEBIT", "10.00", "100.00", "90.00", 2),
    ]);
    void openingId;
    await tx([
      txSql(r1, walletId, { kind: "'REFUND'", refExt: `'${bet}'`, refId: `'${bet}'` }),
      `UPDATE wallets SET balance_amount = 100, version = 3 WHERE id = '${walletId}'`,
      ledgerSql(walletId, r1, "CREDIT", "10.00", "90.00", "100.00", 3),
    ]);
    await expect(
      tx([
        txSql(r2, walletId, { kind: "'ROLLBACK'", refExt: `'${bet}'`, refId: `'${bet}'` }),
        `UPDATE wallets SET balance_amount = 110, version = 4 WHERE id = '${walletId}'`,
        ledgerSql(walletId, r2, "CREDIT", "10.00", "100.00", "110.00", 4),
      ]),
    ).rejects.toThrow(/wager_tx_single_reversal_uq/);
  });
});

describe("inbox / outbox", () => {
  test("inbox is unique per (consumer, message)", async () => {
    await tx([`INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at) VALUES ('c', 'm', 'h', now())`]);
    await expect(
      tx([`INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at) VALUES ('c', 'm', 'h', now())`]),
    ).rejects.toThrow(/duplicate key/);
  });

  test("outbox content is immutable and cannot be un-published", async () => {
    const id = newId();
    await tx([
      `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, next_attempt_at, published_at)
       VALUES ('${id}', '${newId()}', 'E', '{"a":1}', now(), now(), now())`,
    ]);
    await expect(tx([`UPDATE outbox_messages SET payload = '{"a":2}' WHERE id = '${id}'`])).rejects.toThrow(/immutable/);
    await expect(tx([`UPDATE outbox_messages SET published_at = NULL WHERE id = '${id}'`])).rejects.toThrow(/already published/);
  });
});
