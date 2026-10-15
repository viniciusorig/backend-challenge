import { SendMessageBatchCommand } from "@aws-sdk/client-sqs";
import type { MikroORM } from "@mikro-orm/postgresql";
import { OutboxMessage } from "../../domain/messaging/outbox-message";
import type { AppConfig } from "../../shared/config";
import type { JsonLogger } from "../observability/logger";
import type { PrometheusMetrics } from "../observability/metrics";
import { translateDbError } from "../persistence/db-errors";
import type { SqsGateway } from "./sqs-gateway";

interface ClaimedRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
  attempts: number;
  next_attempt_at: Date;
}

export interface PublishReport {
  claimed: number;
  published: number;
  failed: number;
}

/**
 * Transactional-outbox relay. Safe with N concurrent publishers:
 *
 *  1. claim: one short transaction marks a batch with a lease
 *     (`locked_until`, `locked_by`) using FOR UPDATE SKIP LOCKED — two
 *     publishers never claim the same row at the same time;
 *  2. publish to SQS outside of any DB transaction;
 *  3. mark published (only if we still own the lease) or schedule a retry
 *     with exponential backoff.
 *
 * If the process dies between 2 and 3 the lease expires and another instance
 * publishes again: delivery is at-least-once. Duplicates are harmless because
 * every message carries the same `eventId` (also used as the FIFO
 * MessageDeduplicationId), so consumers de-duplicate on it.
 */
export class OutboxPublisher {
  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SqsGateway,
    private readonly options: {
      instanceId: string;
      batchSize: number;
      leaseMs: number;
      crashAfterPublishBeforeMark?: boolean;
    },
    private readonly metrics: PrometheusMetrics,
    private readonly log: JsonLogger,
  ) {}

  async publishBatch(): Promise<PublishReport> {
    const rows = await this.claim();
    // SQS batches hold at most 10 entries; the chunks of one claim are sent in parallel.
    const chunks: ClaimedRow[][] = [];
    for (let i = 0; i < rows.length; i += 10) chunks.push(rows.slice(i, i + 10));
    const results = await Promise.all(chunks.map((chunk) => this.send(chunk)));
    const published = results.flatMap((r) => r.published);
    const failed = results.flatMap((r) => r.failed);
    if (published.length && this.options.crashAfterPublishBeforeMark) {
      this.log.warn("CHAOS: crashing after publish, before marking outbox rows");
      process.exit(137);
    }
    await this.markPublished(published);
    await this.scheduleRetries(failed);
    await this.refreshLagMetrics();
    return { claimed: rows.length, published: published.length, failed: failed.length };
  }

  private async claim(): Promise<ClaimedRow[]> {
    try {
      return await this.orm.em.fork().execute<ClaimedRow[]>(
        `UPDATE outbox_messages o
            SET locked_until = now() + (? * interval '1 millisecond'), locked_by = ?
          WHERE o.id IN (
                SELECT id FROM outbox_messages
                 WHERE published_at IS NULL
                   AND next_attempt_at <= now()
                   AND (locked_until IS NULL OR locked_until < now())
                 ORDER BY occurred_at, id
                 LIMIT ?
                 FOR UPDATE SKIP LOCKED)
        RETURNING o.id, o.aggregate_id, o.event_type, o.payload, o.occurred_at, o.attempts, o.next_attempt_at`,
        [this.options.leaseMs, this.options.instanceId, this.options.batchSize],
      );
    } catch (error) {
      throw translateDbError(error);
    }
  }

  private async send(rows: ClaimedRow[]): Promise<{ published: ClaimedRow[]; failed: Array<[ClaimedRow, string]> }> {
    try {
      const response = await this.sqs.client.send(
        new SendMessageBatchCommand({
          QueueUrl: this.sqs.queues.events,
          Entries: rows.map((row, index) => ({
            Id: String(index),
            MessageBody: JSON.stringify(row.payload),
            MessageGroupId: row.aggregate_id,
            MessageDeduplicationId: row.id,
            MessageAttributes: {
              eventType: { DataType: "String", StringValue: row.event_type },
              eventId: { DataType: "String", StringValue: row.id },
            },
          })),
        }),
      );
      const failedIds = new Map((response.Failed ?? []).map((f) => [f.Id!, f.Code ?? "UNKNOWN"]));
      return {
        published: rows.filter((_, i) => !failedIds.has(String(i))),
        failed: rows.flatMap((row, i) => (failedIds.has(String(i)) ? [[row, failedIds.get(String(i))!] as [ClaimedRow, string]] : [])),
      };
    } catch (error) {
      this.log.warn("outbox publish failed", { error, batch: rows.length });
      const reason = error instanceof Error ? error.message : String(error);
      return { published: [], failed: rows.map((row) => [row, reason] as [ClaimedRow, string]) };
    }
  }

  private async markPublished(rows: ClaimedRow[]): Promise<void> {
    if (!rows.length) return;
    const now = new Date();
    for (const row of rows) {
      const message = this.toDomain(row);
      message.markPublished(now);
    }
    // No lease check here: the event *was* published. If our lease expired and
    // another publisher also sent it, the first mark wins and the copy is a
    // harmless duplicate (same eventId).
    const ids = rows.map((r) => r.id);
    await this.orm.em.fork().execute(
      `UPDATE outbox_messages SET published_at = ?, locked_until = NULL, last_error = NULL
        WHERE id IN (${ids.map(() => "?").join(", ")}) AND published_at IS NULL`,
      [now, ...ids],
    );
    for (const row of rows) this.metrics.outboxPublished.inc({ event_type: row.event_type });
  }

  private async scheduleRetries(failed: Array<[ClaimedRow, string]>): Promise<void> {
    if (!failed.length) return;
    const now = new Date();
    const em = this.orm.em.fork();
    for (const [row, reason] of failed) {
      const message = this.toDomain(row);
      message.scheduleRetry(now);
      await em.execute(
        `UPDATE outbox_messages
            SET attempts = ?, next_attempt_at = ?, locked_until = NULL, locked_by = NULL, last_error = ?
          WHERE id = ? AND published_at IS NULL AND locked_by = ?`,
        [message.attempts, message.nextAttemptAt, reason.slice(0, 1000), row.id, this.options.instanceId],
      );
      this.metrics.outboxFailures.inc();
    }
  }

  async refreshLagMetrics(): Promise<void> {
    const [row] = await this.orm.em.fork().execute<{ pending: number; lag: number | null }[]>(
      `SELECT COUNT(*)::int AS pending,
              EXTRACT(EPOCH FROM now() - MIN(occurred_at))::float8 AS lag
         FROM outbox_messages WHERE published_at IS NULL`,
    );
    this.metrics.outboxPending.set(Number(row?.pending ?? 0));
    this.metrics.outboxLag.set(Math.max(0, Number(row?.lag ?? 0)));
  }

  private toDomain(row: ClaimedRow): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: row.id,
      aggregateId: row.aggregate_id,
      eventType: row.event_type,
      payload: row.payload,
      occurredAt: row.occurred_at,
      attempts: row.attempts,
      nextAttemptAt: row.next_attempt_at,
    });
  }
}
