import { InvalidTransactionStateError } from "../errors";
import type { IntegrationEvent } from "../events/integration-event";

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

export interface RetryPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_OUTBOX_RETRY: RetryPolicy = { baseDelayMs: 1_000, maxDelayMs: 5 * 60_000 };

/** Exponential backoff with full jitter, capped. */
export function backoffDelayMs(attempt: number, policy: RetryPolicy, random: () => number = Math.random): number {
  const exp = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp / 2 + (random() * exp) / 2);
}

/**
 * An integration event waiting to be published. The id is the event id, so a
 * duplicate publication carries the same id and consumers can de-duplicate.
 */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const payload = JSON.parse(JSON.stringify(event.toJSON())) as Record<string, unknown>;
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      Object.freeze(payload),
      event.occurredAt,
      0,
      event.occurredAt,
    );
  }

  static rehydrate(s: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      s.id,
      s.aggregateId,
      s.eventType,
      s.payload,
      s.occurredAt,
      s.attempts,
      s.nextAttemptAt,
      s.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }
  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt <= now);
  }

  markPublished(at: Date): void {
    if (!this.isPending()) {
      throw new InvalidTransactionStateError(`Outbox message ${this.id} already published`);
    }
    this._publishedAt = at;
    this._nextAttemptAt = undefined;
  }

  /** Increments attempts and computes the next attempt time (exponential backoff). */
  scheduleRetry(now: Date, policy: RetryPolicy = DEFAULT_OUTBOX_RETRY): void {
    if (!this.isPending()) {
      throw new InvalidTransactionStateError(`Outbox message ${this.id} already published`);
    }
    this._attempts += 1;
    this._nextAttemptAt = new Date(now.getTime() + backoffDelayMs(this._attempts, policy));
  }
}
