import {
  GetQueueAttributesCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  DeleteMessageCommand,
  type Message,
} from "@aws-sdk/client-sqs";
import type { MikroORM } from "@mikro-orm/postgresql";
import type { SubmitWagerCommand } from "../../src/application/commands";
import { systemClock } from "../../src/application/ports/clock";
import { OpenWallet } from "../../src/application/use-cases/open-wallet";
import { WageringQueries } from "../../src/application/use-cases/queries";
import { ReconcileWallet } from "../../src/application/use-cases/reconcile-wallet";
import { ResolvePendingReferences } from "../../src/application/use-cases/resolve-pending-references";
import { SubmitWagerTransaction } from "../../src/application/use-cases/submit-wager-transaction";
import { WagerDecisionService } from "../../src/application/wager-decision";
import { JsonLogger } from "../../src/infrastructure/observability/logger";
import { PrometheusMetrics } from "../../src/infrastructure/observability/metrics";
import { MikroOrmUnitOfWork } from "../../src/infrastructure/persistence/mikro-orm-unit-of-work";
import { OutboxPublisher } from "../../src/infrastructure/sqs/outbox-publisher";
import { SqsGateway } from "../../src/infrastructure/sqs/sqs-gateway";
import { WagerConsumer } from "../../src/interface/sqs/wager-consumer";
import type { AppConfig } from "../../src/shared/config";
import { newId } from "../../src/shared/ids";
import { openOrm } from "./db";

export const quietLogger = new JsonLogger(process.env.TEST_LOG_LEVEL ?? "error", { service: "test" });

/** Real PostgreSQL + real SQS wiring, without the HTTP layer. */
export async function createHarness(config: AppConfig) {
  const orm = await openOrm(config.db.url, config.db.poolMax);
  const sqs = new SqsGateway(config.sqs);
  await sqs.init();
  const metrics = new PrometheusMetrics();
  const uow = new MikroOrmUnitOfWork(orm, {
    lockTimeoutMs: config.db.lockTimeoutMs,
    statementTimeoutMs: config.db.statementTimeoutMs,
  });
  const decisions = new WagerDecisionService({
    baseDelayMs: config.workers.referenceBaseDelayMs,
    maxDelayMs: config.workers.referenceMaxDelayMs,
    maxAttempts: config.workers.referenceMaxAttempts,
  });
  const submit = new SubmitWagerTransaction(uow, decisions, systemClock, metrics, config.db.transientRetries);
  const resolver = new ResolvePendingReferences(uow, decisions, systemClock, metrics, config.db.transientRetries);
  const openWallet = new OpenWallet(uow, systemClock);
  const queries = new WageringQueries(uow);
  const reconcile = new ReconcileWallet(uow, metrics, () => {});

  const newConsumer = (overrides: Partial<AppConfig["chaos"]> = {}) =>
    new WagerConsumer(
      sqs,
      submit,
      { ...config.sqs, consumerName: config.workers.consumerName, shutdownGraceMs: config.workers.shutdownGraceMs },
      { ...config.chaos, ...overrides },
      metrics,
      quietLogger,
    );
  const newPublisher = (instanceId: string, leaseMs = config.workers.outboxLeaseMs, batchSize = 10) =>
    new OutboxPublisher(orm, sqs, { instanceId, batchSize, leaseMs }, metrics, quietLogger);

  return {
    config,
    orm,
    sqs,
    metrics,
    uow,
    submit,
    resolver,
    openWallet,
    queries,
    reconcile,
    newConsumer,
    newPublisher,
    async close() {
      await orm.close(true);
      sqs.client.destroy();
    },
  };
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;

export async function openTestWallet(h: Harness, amount = "100.00", currency = "BRL") {
  const playerId = `player-${newId()}`;
  const wallet = await h.openWallet.execute({ playerId, initialBalance: { amount, currency } }, "test");
  return { walletId: wallet.id, playerId };
}

export function wager(
  wallet: { walletId: string; playerId: string },
  kind: string,
  amount: string,
  externalTransactionId: string = newId(),
  extra: Partial<SubmitWagerCommand> = {},
): SubmitWagerCommand {
  return {
    idempotencyKey: `provider-a:${externalTransactionId}`,
    providerId: "provider-a",
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind,
    money: { amount, currency: "BRL" },
    ...extra,
  };
}

export function wagerMessage(cmd: SubmitWagerCommand, messageId: string = newId()) {
  return {
    messageId,
    type: "WagerTransactionRequested",
    occurredAt: new Date().toISOString(),
    data: cmd,
  };
}

export async function sendToQueue(h: Harness, body: unknown, groupId: string, dedupId: string = newId()) {
  await h.sqs.client.send(
    new SendMessageCommand({
      QueueUrl: h.sqs.queues.input,
      MessageBody: typeof body === "string" ? body : JSON.stringify(body),
      MessageGroupId: groupId,
      MessageDeduplicationId: dedupId,
    }),
  );
}

export async function queueDepth(h: Harness, queueUrl: string): Promise<{ visible: number; inFlight: number }> {
  const r = await h.sqs.client.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
    }),
  );
  return {
    visible: Number(r.Attributes?.ApproximateNumberOfMessages ?? 0),
    inFlight: Number(r.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0),
  };
}

/** Receives (and deletes) everything currently visible in a queue. */
export async function drainQueue(h: Harness, queueUrl: string, idleRounds = 2): Promise<Message[]> {
  const all: Message[] = [];
  let idle = 0;
  while (idle < idleRounds) {
    const r = await h.sqs.client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        MessageAttributeNames: ["All"],
      }),
    );
    const messages = r.Messages ?? [];
    if (!messages.length) {
      idle++;
      continue;
    }
    idle = 0;
    all.push(...messages);
    for (const m of messages) {
      await h.sqs.client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: m.ReceiptHandle! }));
    }
  }
  return all;
}

export async function purge(h: Harness, queueUrl: string) {
  try {
    await h.sqs.client.send(new PurgeQueueCommand({ QueueUrl: queueUrl }));
  } catch {
    // purge may be rate limited; tests use fresh queues anyway
  }
}

export async function eventually<T>(
  check: () => Promise<T | undefined | false>,
  { timeoutMs = 20_000, intervalMs = 100, message = "condition not met" } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await Bun.sleep(intervalMs);
  }
  throw new Error(`${message} (after ${timeoutMs}ms)${last ? `: ${String(last)}` : ""}`);
}
