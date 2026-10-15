/**
 * Load test: `bun run test:load`
 *
 * Starts N real instances (separate processes) against the local compose
 * PostgreSQL / SQS, then drives HTTP BETs with a fixed concurrency for a fixed
 * duration. Two profiles run back to back:
 *   - spread:  bets over many wallets (parallelism across wallets)
 *   - hot:     every bet on ONE wallet (worst case: row lock contention)
 * Prints throughput, latency percentiles, status mix, lock conflicts and
 * outbox lag, then checks wallet.balance == ledger for every wallet.
 *
 * Env: LOAD_INSTANCES (3) LOAD_CONCURRENCY (64) LOAD_DURATION_SEC (20) LOAD_WALLETS (200)
 */
import os from "node:os";
import { migrateFresh, openOrm, auditWallets, sql } from "../test/support/db";
import { testConfig } from "../test/support/env";
import { Instance, freePorts } from "../test/support/instances";
import { newId } from "../src/shared/ids";

const INSTANCES = Number(process.env.LOAD_INSTANCES ?? 3);
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 64);
const DURATION = Number(process.env.LOAD_DURATION_SEC ?? 20) * 1000;
const WALLETS = Number(process.env.LOAD_WALLETS ?? 200);

const config = testConfig({ db: { lockTimeoutMs: 3000 } }, "load");
const orm = await openOrm();
await migrateFresh(orm);
const instances = await Promise.all(freePorts(INSTANCES).map((p, i) => Instance.start(config, p, `load-${i + 1}`)));

async function openWallets(n: number, amount: string) {
  const wallets: { walletId: string; playerId: string }[] = [];
  for (let i = 0; i < n; i++) {
    const playerId = newId();
    const res = await instances[i % INSTANCES]!.post("/wallets", { playerId, initialBalance: { amount, currency: "BRL" } });
    wallets.push({ walletId: res.body.id, playerId });
  }
  return wallets;
}

function pct(sorted: number[], p: number) {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]! : 0;
}

async function scrape(metric: string): Promise<number> {
  let total = 0;
  for (const i of instances) {
    const text = await (await fetch(`${i.url}/metrics`)).text();
    for (const line of text.split("\n")) {
      if (line.startsWith(metric) && !line.startsWith("#")) total += Number(line.split(" ").at(-1));
    }
  }
  return total;
}

async function run(name: string, wallets: { walletId: string; playerId: string }[]) {
  const latencies: number[] = [];
  const statuses = new Map<number, number>();
  let errors = 0;
  let maxLag = 0;
  const lockBefore = await scrape("wagering_lock_conflicts_total");
  const deadline = Date.now() + DURATION;
  let seq = 0;

  const lagProbe = setInterval(async () => {
    const [row] = await sql<{ lag: number | null }>(
      orm,
      `SELECT EXTRACT(EPOCH FROM now() - MIN(occurred_at))::float8 AS lag FROM outbox_messages WHERE published_at IS NULL`,
    );
    maxLag = Math.max(maxLag, Number(row?.lag ?? 0));
  }, 250);

  const worker = async () => {
    while (Date.now() < deadline) {
      const n = seq++;
      const w = wallets[n % wallets.length]!;
      const ext = newId();
      const started = performance.now();
      try {
        const res = await fetch(`${instances[n % INSTANCES]!.url}/wagering/transactions`, {
          method: "POST",
          headers: { "content-type": "application/json", "Idempotency-Key": `load:${ext}` },
          body: JSON.stringify({
            providerId: "load",
            externalTransactionId: ext,
            playerId: w.playerId,
            walletId: w.walletId,
            roundId: "r",
            gameId: "g",
            kind: "BET",
            money: { amount: "0.01", currency: "BRL" },
          }),
        });
        await res.arrayBuffer();
        statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
        if (res.status >= 500) errors++;
      } catch {
        errors++;
      }
      latencies.push(performance.now() - started);
    }
  };
  const t0 = performance.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const elapsed = (performance.now() - t0) / 1000;
  clearInterval(lagProbe);
  latencies.sort((a, b) => a - b);
  const lockAfter = await scrape("wagering_lock_conflicts_total");
  return {
    profile: name,
    requests: latencies.length,
    throughputRps: Math.round(latencies.length / elapsed),
    p50ms: +pct(latencies, 50).toFixed(1),
    p95ms: +pct(latencies, 95).toFixed(1),
    p99ms: +pct(latencies, 99).toFixed(1),
    maxMs: +(latencies.at(-1) ?? 0).toFixed(1),
    errorRate: +(errors / Math.max(1, latencies.length)).toFixed(4),
    statuses: Object.fromEntries(statuses),
    lockConflicts: lockAfter - lockBefore,
    maxOutboxLagSec: +maxLag.toFixed(2),
  };
}

try {
  console.log(
    JSON.stringify({
      environment: {
        cpu: os.cpus()[0]?.model,
        cores: os.cpus().length,
        memoryGb: Math.round(os.totalmem() / 2 ** 30),
        bun: Bun.version,
        instances: INSTANCES,
        concurrency: CONCURRENCY,
        durationSec: DURATION / 1000,
      },
    }),
  );
  const spread = await openWallets(WALLETS, "100000.00");
  console.log(JSON.stringify(await run(`spread (${WALLETS} wallets)`, spread)));
  const hot = await openWallets(1, "100000.00");
  console.log(JSON.stringify(await run("hot (1 wallet)", hot)));

  const audits = await auditWallets(orm);
  const broken = audits.filter((a) => a.balance !== a.ledgerSum);
  console.log(JSON.stringify({ walletsAudited: audits.length, ledgerMismatches: broken.length }));
} finally {
  await Promise.all(instances.map((i) => i.stop()));
  await orm.close(true);
}
