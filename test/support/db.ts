import { MikroORM } from "@mikro-orm/postgresql";
import { buildOrmConfig } from "../../src/infrastructure/persistence/mikro-orm.config";
import { TEST_DATABASE_URL } from "./env";

export async function openOrm(url = TEST_DATABASE_URL, poolMax = 30): Promise<MikroORM> {
  return MikroORM.init(buildOrmConfig({ db: { url, poolMax } as never }));
}

/** Drops everything and re-applies the versioned migrations (also exercises `up`). */
export async function migrateFresh(orm: MikroORM): Promise<void> {
  await orm.em.fork().execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await orm.getMigrator().up();
}

/**
 * Empties all tables between tests. The ledger refuses TRUNCATE by design, so
 * the reset runs with triggers disabled (session_replication_role = replica;
 * superuser-only, test database only).
 */
export async function resetData(orm: MikroORM): Promise<void> {
  await orm.em.fork().execute(`
    SET session_replication_role = replica;
    TRUNCATE inbox_messages, outbox_messages, wallet_ledger_entries, wager_transactions, wallets;
    SET session_replication_role = origin;
  `);
}

export async function sql<T = Record<string, unknown>>(orm: MikroORM, query: string, params: unknown[] = []): Promise<T[]> {
  return orm.em.fork().execute<T[]>(query, params);
}

export interface WalletAudit {
  walletId: string;
  balance: string;
  ledgerSum: string;
  lastBalanceAfter: string | null;
  version: number;
  lastLedgerVersion: number | null;
  entries: number;
}

/**
 * The invariant every test ends with:
 *   wallet.balance == Σ credits − Σ debits (ledger) == last ledger balance_after
 */
export async function auditWallets(orm: MikroORM): Promise<WalletAudit[]> {
  return sql<WalletAudit>(
    orm,
    `SELECT w.id AS "walletId",
            w.balance_amount::text AS balance,
            COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0)::numeric(20,2)::text AS "ledgerSum",
            (SELECT balance_after::text FROM wallet_ledger_entries x WHERE x.wallet_id = w.id ORDER BY wallet_version DESC LIMIT 1) AS "lastBalanceAfter",
            w.version,
            (SELECT MAX(wallet_version) FROM wallet_ledger_entries x WHERE x.wallet_id = w.id) AS "lastLedgerVersion",
            COUNT(l.id)::int AS entries
       FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
      GROUP BY w.id`,
  );
}

export async function expectLedgerConsistent(orm: MikroORM): Promise<WalletAudit[]> {
  const audits = await auditWallets(orm);
  const broken = audits.filter(
    (a) =>
      a.balance !== a.ledgerSum ||
      (a.lastBalanceAfter !== null && a.lastBalanceAfter !== a.balance) ||
      (a.lastLedgerVersion !== null && Number(a.lastLedgerVersion) !== a.version),
  );
  if (broken.length) {
    throw new Error(`Ledger invariant broken: ${JSON.stringify(broken, null, 2)}`);
  }
  return audits;
}
