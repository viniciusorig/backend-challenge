/**
 * Application level errors. Each has a stable `code` and a `category` the
 * adapters (HTTP / SQS) translate into a status code or an ack/retry/DLQ
 * decision — the mapping lives in one place per adapter.
 */
export type ErrorCategory =
  | "VALIDATION" // payload can never succeed as is
  | "NOT_FOUND"
  | "CONFLICT" // idempotency / uniqueness conflict
  | "TRANSIENT"; // infrastructure hiccup: retry later

export abstract class ApplicationError extends Error {
  abstract readonly code: string;
  abstract readonly category: ErrorCategory;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class WalletNotFoundError extends ApplicationError {
  readonly code = "WALLET_NOT_FOUND";
  readonly category = "NOT_FOUND" as const;
  constructor(walletId: string) {
    super(`Wallet ${walletId} not found`);
  }
}

export class TransactionNotFoundError extends ApplicationError {
  readonly code = "TRANSACTION_NOT_FOUND";
  readonly category = "NOT_FOUND" as const;
  constructor(what: string) {
    super(`Transaction ${what} not found`);
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = "WALLET_ALREADY_EXISTS";
  readonly category = "CONFLICT" as const;
  constructor(playerId: string, currency: string) {
    super(`Player ${playerId} already has a ${currency} wallet`);
  }
}

/** Same idempotency key (or same provider external id) with a different payload. */
export class IdempotencyConflictError extends ApplicationError {
  readonly category = "CONFLICT" as const;
  constructor(
    readonly code: "IDEMPOTENCY_KEY_CONFLICT" | "EXTERNAL_TRANSACTION_ID_CONFLICT" | "INBOX_MESSAGE_CONFLICT",
    message: string,
    readonly existingTransactionId?: string,
  ) {
    super(message);
  }
}

export class InvalidRequestError extends ApplicationError {
  readonly code = "VALIDATION_ERROR";
  readonly category = "VALIDATION" as const;
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** Safe to retry: connection loss, lock timeout, deadlock, serialization failure, broker unavailable. */
export class TransientInfrastructureError extends ApplicationError {
  readonly category = "TRANSIENT" as const;
  constructor(
    readonly code: "DATABASE_UNAVAILABLE" | "LOCK_TIMEOUT" | "CONCURRENCY_CONFLICT" | "BROKER_UNAVAILABLE",
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** A unique constraint fired: another writer won a race. Callers decide whether it is a conflict or a retry. */
export class UniqueViolationError extends ApplicationError {
  readonly code = "UNIQUE_VIOLATION";
  readonly category = "CONFLICT" as const;
  constructor(
    readonly constraint: string | undefined,
    options?: { cause?: unknown },
  ) {
    super(`Unique constraint violated: ${constraint ?? "unknown"}`, options);
  }
}
