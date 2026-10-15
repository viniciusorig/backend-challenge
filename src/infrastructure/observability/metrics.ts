import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import type { RequestSource, WageringMetrics } from "../../application/ports/metrics";

/** All Prometheus metrics of the service, exposed at GET /metrics. */
export class PrometheusMetrics implements WageringMetrics {
  readonly registry = new Registry();

  readonly transactions = new Counter({
    name: "wagering_transactions_total",
    help: "Wager transactions by final status of the request",
    labelNames: ["kind", "status", "source"] as const,
    registers: [this.registry],
  });
  readonly processingLatency = new Histogram({
    name: "wagering_processing_duration_seconds",
    help: "End-to-end processing latency of a wager transaction (including retries)",
    labelNames: ["source"] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });
  readonly duplicates = new Counter({
    name: "wagering_duplicates_total",
    help: "Duplicates detected (idempotent replays and redelivered messages)",
    labelNames: ["type", "source"] as const,
    registers: [this.registry],
  });
  readonly retries = new Counter({
    name: "wagering_retries_total",
    help: "Retries by operation and reason",
    labelNames: ["operation", "reason"] as const,
    registers: [this.registry],
  });
  readonly lockConflicts = new Counter({
    name: "wagering_lock_conflicts_total",
    help: "Wallet lock timeouts / concurrency conflicts",
    registers: [this.registry],
  });
  readonly sqsMessages = new Counter({
    name: "sqs_messages_total",
    help: "Consumed SQS messages by outcome",
    labelNames: ["outcome"] as const,
    registers: [this.registry],
  });
  readonly dlqMessages = new Counter({
    name: "sqs_dlq_messages_total",
    help: "Messages moved to the DLQ by reason",
    labelNames: ["reason"] as const,
    registers: [this.registry],
  });
  readonly outboxPublished = new Counter({
    name: "outbox_published_total",
    help: "Outbox messages published",
    labelNames: ["event_type"] as const,
    registers: [this.registry],
  });
  readonly outboxFailures = new Counter({
    name: "outbox_publish_failures_total",
    help: "Outbox publish failures (rescheduled with backoff)",
    registers: [this.registry],
  });
  readonly outboxLag = new Gauge({
    name: "outbox_lag_seconds",
    help: "Age of the oldest unpublished outbox message",
    registers: [this.registry],
  });
  readonly outboxPending = new Gauge({
    name: "outbox_pending_messages",
    help: "Unpublished outbox messages",
    registers: [this.registry],
  });
  readonly reconciliations = new Counter({
    name: "wallet_reconciliations_total",
    help: "Wallet reconciliations by result",
    labelNames: ["result"] as const,
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }

  transactionFinished(kind: string, status: string, source: RequestSource, durationSeconds: number): void {
    this.transactions.inc({ kind, status, source });
    this.processingLatency.observe({ source }, durationSeconds);
  }
  duplicateDetected(type: "idempotency_replay" | "inbox_message", source: RequestSource): void {
    this.duplicates.inc({ type, source });
  }
  retry(operation: string, reason: string): void {
    this.retries.inc({ operation, reason });
  }
  lockConflict(): void {
    this.lockConflicts.inc();
  }
  reconciliationChecked(consistent: boolean): void {
    this.reconciliations.inc({ result: consistent ? "consistent" : "divergent" });
  }
}
