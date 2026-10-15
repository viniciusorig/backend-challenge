import { type AppConfig, loadConfig } from "../../src/shared/config";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://wagering:wagering@localhost:5432/wagering_test";
export const TEST_SQS_ENDPOINT = process.env.TEST_SQS_ENDPOINT ?? "http://localhost:4566";

/** Unique, short queue names so test files never see each other's messages. */
export function queueNames(prefix: string) {
  const suffix = `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return {
    inputQueue: `wt-${suffix}.fifo`,
    dlqQueue: `wt-dlq-${suffix}.fifo`,
    eventsQueue: `we-${suffix}.fifo`,
  };
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export function testConfig(overrides: DeepPartial<AppConfig> = {}, queuePrefix = "t"): AppConfig {
  const base = loadConfig();
  const config: AppConfig = {
    ...base,
    instanceId: "test",
    db: { ...base.db, url: TEST_DATABASE_URL, poolMax: 30, lockTimeoutMs: 5_000 },
    sqs: {
      ...base.sqs,
      endpoint: TEST_SQS_ENDPOINT,
      ...queueNames(queuePrefix),
      autoCreateQueues: true,
      visibilityTimeoutSec: 5,
      waitTimeSec: 1,
      maxReceiveCount: 3,
      retryBaseDelaySec: 1,
    },
    workers: {
      ...base.workers,
      outboxPollMs: 100,
      pendingReferencePollMs: 100,
      referenceBaseDelayMs: 100,
      referenceMaxDelayMs: 400,
      referenceMaxAttempts: 4,
      shutdownGraceMs: 5_000,
    },
    // Most suites test the financial core; auth is covered by test/integration/auth.test.ts.
    auth: { ...base.auth, enabled: false },
    chaos: { crashAfterCommitBeforeAck: false, crashAfterPublishBeforeMark: false },
  };
  return merge(config, overrides);
}

function merge<T>(target: T, patch: DeepPartial<T>): T {
  const out = { ...target } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    const current = out[key];
    out[key] =
      value && typeof value === "object" && !Array.isArray(value) && current && typeof current === "object"
        ? merge(current, value as DeepPartial<typeof current>)
        : value;
  }
  return out as T;
}

/** Environment variables equivalent to a config (for spawned instances). */
export function configToEnv(config: AppConfig, port: number, instanceId: string): Record<string, string> {
  return {
    PORT: String(port),
    INSTANCE_ID: instanceId,
    LOG_LEVEL: process.env.TEST_INSTANCE_LOG_LEVEL ?? "warn",
    DATABASE_URL: config.db.url,
    DB_POOL_MAX: "15",
    DB_LOCK_TIMEOUT_MS: String(config.db.lockTimeoutMs),
    SQS_ENDPOINT: config.sqs.endpoint,
    SQS_INPUT_QUEUE: config.sqs.inputQueue,
    SQS_DLQ_QUEUE: config.sqs.dlqQueue,
    SQS_EVENTS_QUEUE: config.sqs.eventsQueue,
    SQS_VISIBILITY_TIMEOUT_SEC: String(config.sqs.visibilityTimeoutSec),
    SQS_WAIT_TIME_SEC: String(config.sqs.waitTimeSec),
    SQS_MAX_RECEIVE_COUNT: String(config.sqs.maxReceiveCount),
    SQS_RETRY_BASE_DELAY_SEC: String(config.sqs.retryBaseDelaySec),
    OUTBOX_POLL_MS: String(config.workers.outboxPollMs),
    PENDING_REFERENCE_POLL_MS: String(config.workers.pendingReferencePollMs),
    REFERENCE_RETRY_BASE_DELAY_MS: String(config.workers.referenceBaseDelayMs),
    REFERENCE_RETRY_MAX_DELAY_MS: String(config.workers.referenceMaxDelayMs),
    REFERENCE_RETRY_MAX_ATTEMPTS: String(config.workers.referenceMaxAttempts),
    OUTBOX_LEASE_MS: String(config.workers.outboxLeaseMs),
    SHUTDOWN_GRACE_MS: String(config.workers.shutdownGraceMs),
    AUTH_ENABLED: String(config.auth.enabled),
    AUTH_ISSUER: config.auth.issuer,
    AUTH_JWKS_URI: config.auth.jwksUri,
    AUTH_TOKEN_URL: config.auth.tokenUrl,
  };
}
