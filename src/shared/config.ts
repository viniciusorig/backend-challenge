/** Typed configuration read once from the environment (Bun loads .env automatically). */
function str(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`Missing env var ${name}`);
  return value;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) throw new Error(`Env var ${name} must be an integer`);
  return parsed;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw === "true" || raw === "1";
}

export function loadConfig() {
  return {
    instanceId: str("INSTANCE_ID", `${process.pid}`),
    http: { port: int("PORT", 3000) },
    db: {
      url: str("DATABASE_URL", "postgres://wagering:wagering@localhost:5432/wagering"),
      poolMax: int("DB_POOL_MAX", 20),
      lockTimeoutMs: int("DB_LOCK_TIMEOUT_MS", 3_000),
      statementTimeoutMs: int("DB_STATEMENT_TIMEOUT_MS", 10_000),
      transientRetries: int("DB_TRANSIENT_RETRIES", 3),
    },
    sqs: {
      endpoint: str("SQS_ENDPOINT", "http://localhost:4566"),
      region: str("AWS_REGION", "us-east-1"),
      accessKeyId: str("AWS_ACCESS_KEY_ID", "test"),
      secretAccessKey: str("AWS_SECRET_ACCESS_KEY", "test"),
      inputQueue: str("SQS_INPUT_QUEUE", "wager-transactions.fifo"),
      dlqQueue: str("SQS_DLQ_QUEUE", "wager-transactions-dlq.fifo"),
      eventsQueue: str("SQS_EVENTS_QUEUE", "wagering-events.fifo"),
      autoCreateQueues: bool("SQS_AUTO_CREATE_QUEUES", true),
      visibilityTimeoutSec: int("SQS_VISIBILITY_TIMEOUT_SEC", 30),
      waitTimeSec: int("SQS_WAIT_TIME_SEC", 10),
      maxReceiveCount: int("SQS_MAX_RECEIVE_COUNT", 5),
      retryBaseDelaySec: int("SQS_RETRY_BASE_DELAY_SEC", 2),
    },
    workers: {
      consumerEnabled: bool("CONSUMER_ENABLED", true),
      consumerName: str("CONSUMER_NAME", "wagering-processor"),
      outboxEnabled: bool("OUTBOX_PUBLISHER_ENABLED", true),
      outboxPollMs: int("OUTBOX_POLL_MS", 500),
      outboxBatchSize: int("OUTBOX_BATCH_SIZE", 200),
      outboxLeaseMs: int("OUTBOX_LEASE_MS", 30_000),
      pendingReferenceEnabled: bool("PENDING_REFERENCE_WORKER_ENABLED", true),
      pendingReferencePollMs: int("PENDING_REFERENCE_POLL_MS", 1_000),
      referenceBaseDelayMs: int("REFERENCE_RETRY_BASE_DELAY_MS", 1_000),
      referenceMaxDelayMs: int("REFERENCE_RETRY_MAX_DELAY_MS", 5 * 60_000),
      referenceMaxAttempts: int("REFERENCE_RETRY_MAX_ATTEMPTS", 10),
      shutdownGraceMs: int("SHUTDOWN_GRACE_MS", 20_000),
    },
    auth: (() => {
      const issuer = str("AUTH_ISSUER", "http://localhost:8080/realms/wagering");
      return {
        /** false = no authentication at all (local experiments / most automated tests). */
        enabled: bool("AUTH_ENABLED", true),
        issuer,
        audience: str("AUTH_AUDIENCE", "wagering-api"),
        jwksUri: str("AUTH_JWKS_URI", `${issuer}/protocol/openid-connect/certs`),
        tokenUrl: str("AUTH_TOKEN_URL", `${issuer}/protocol/openid-connect/token`),
        operatorRole: str("AUTH_OPERATOR_ROLE", "operator"),
      };
    })(),
    /** Test-only fault injection. Never enable in production. */
    chaos: {
      crashAfterCommitBeforeAck: bool("CHAOS_CRASH_AFTER_COMMIT_BEFORE_ACK", false),
      crashAfterPublishBeforeMark: bool("CHAOS_CRASH_AFTER_PUBLISH_BEFORE_MARK", false),
    },
    logLevel: str("LOG_LEVEL", "info"),
  };
}

export type AppConfig = ReturnType<typeof loadConfig>;
export const APP_CONFIG = Symbol("APP_CONFIG");
