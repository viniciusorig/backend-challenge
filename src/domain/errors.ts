/**
 * Base class for every error raised by the domain layer.
 * `code` is stable and machine readable; the HTTP / SQS adapters map it.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Input that can never become valid by retrying (bad amount, bad currency, ...). */
export class InvalidArgumentError extends DomainError {
  readonly code = "VALIDATION_ERROR";
}

export class CurrencyMismatchError extends DomainError {
  readonly code = "CURRENCY_MISMATCH";

  constructor(expected: string, actual: string) {
    super(`Currency mismatch: expected ${expected}, got ${actual}`);
  }
}

export class InsufficientFundsError extends DomainError {
  readonly code = "INSUFFICIENT_FUNDS";

  constructor() {
    super("Insufficient funds");
  }
}

/** Programming error: an invalid state transition was attempted. */
export class InvalidTransactionStateError extends DomainError {
  readonly code = "INVALID_TRANSACTION_STATE";
}

/** Ledger arithmetic does not hold (balanceBefore ± money !== balanceAfter). */
export class UnbalancedLedgerEntryError extends DomainError {
  readonly code = "UNBALANCED_LEDGER_ENTRY";
}
