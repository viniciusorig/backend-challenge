import { InvalidArgumentError, InvalidTransactionStateError } from "../errors";
import { Money } from "../money/money";
import { LedgerDirection, oppositeDirection } from "../wallet/ledger-direction";
import { FailureCode } from "./failure-code";

export enum WagerTransactionKind {
  Opening = "OPENING", // internal: opening credit of a wallet
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

/** Reserved provider id for internal transactions; external providers cannot use it. */
export const OPENING_PROVIDER_ID = "__internal__";

/** Kinds a provider may submit (HTTP or SQS). OPENING is internal only. */
export const EXTERNAL_KINDS = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
] as const;
export type ExternalKind = (typeof EXTERNAL_KINDS)[number];

export enum WagerTransactionStatus {
  Pending = "PENDING", // accepted, not applied yet
  PendingReference = "PENDING_REFERENCE", // waiting for the referenced transaction
  Processed = "PROCESSED", // applied (terminal)
  Rejected = "REJECTED", // business rule violation (terminal)
  Failed = "FAILED", // permanent infrastructure error (terminal, auditable)
}

const TERMINAL = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

/** Which referenced kinds each operation may point to. */
const ALLOWED_REFERENCE_KINDS: Partial<Record<WagerTransactionKind, readonly WagerTransactionKind[]>> = {
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund],
};

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  correlationId: string;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  observedBalance?: Money;
  referenceAttempts: number;
  nextReferenceAttemptAt?: Date;
}

/** Outcome of checking a candidate reference. */
export type ReferenceCheck = { ok: true } | { ok: false; wait: true } | { ok: false; wait: false; code: FailureCode };

/**
 * A provider operation (or the internal OPENING credit).
 *
 * Valid transitions:
 *
 *   PENDING ──► PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
 *   PENDING_REFERENCE ──► PROCESSED | REJECTED | FAILED
 *                     ──► PENDING_REFERENCE (scheduleReferenceRetry: same status, attempts + 1)
 *   PROCESSED / REJECTED / FAILED: terminal, no transition allowed.
 *
 * `observedBalance` is the wallet balance right after the transaction was
 * decided (or right when it was rejected). Idempotent replays return it, so a
 * replay reports the balance seen at that moment, not today's balance.
 */
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** id at the provider — not the internal id */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly correlationId: string,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _observedBalance?: Money,
    private _referenceAttempts: number = 0,
    private _nextReferenceAttemptAt?: Date,
  ) {}

  /** Born PENDING. Validates the reference requirement per kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    for (const field of ["providerId", "externalTransactionId", "idempotencyKey", "roundId", "gameId"] as const) {
      if (!props[field] || props[field].trim() === "") {
        throw new InvalidArgumentError(`${field} is required`);
      }
    }
    const requiresReference =
      props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback;
    if (requiresReference && !props.referenceExternalTransactionId) {
      throw new InvalidArgumentError(`${props.kind} requires referenceExternalTransactionId`);
    }
    if (props.kind === WagerTransactionKind.Bet && props.referenceExternalTransactionId) {
      throw new InvalidArgumentError("BET cannot reference another transaction");
    }
    if (props.referenceExternalTransactionId === props.externalTransactionId) {
      throw new InvalidArgumentError("A transaction cannot reference itself");
    }
    // LOSS records an outcome and may carry 0.00; everything else moves money.
    if (props.kind === WagerTransactionKind.Loss ? props.money.isNegative() : !props.money.isPositive()) {
      throw new InvalidArgumentError(`${props.kind} amount must be ${props.kind === "LOSS" ? "≥ 0" : "> 0"}`);
    }
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.correlationId,
      props.createdAt,
      WagerTransactionStatus.Pending,
    );
  }

  /** Internal OPENING credit, created in the same SQL transaction as the wallet. */
  static opening(props: {
    id: string;
    walletId: string;
    playerId: string;
    money: Money;
    correlationId: string;
    at: Date;
  }): WagerTransaction {
    const tx = WagerTransaction.create({
      id: props.id,
      providerId: OPENING_PROVIDER_ID,
      externalTransactionId: `opening:${props.walletId}`,
      idempotencyKey: `${OPENING_PROVIDER_ID}:opening:${props.walletId}`,
      payloadHash: "",
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: "opening",
      gameId: "internal",
      kind: WagerTransactionKind.Opening,
      money: props.money,
      correlationId: props.correlationId,
      createdAt: props.at,
    });
    tx.markProcessed(undefined, props.at, props.money);
    return tx;
  }

  static rehydrate(s: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      s.id,
      s.providerId,
      s.externalTransactionId,
      s.idempotencyKey,
      s.payloadHash,
      s.walletId,
      s.playerId,
      s.roundId,
      s.gameId,
      s.kind,
      s.money,
      s.referenceExternalTransactionId,
      s.correlationId,
      s.createdAt,
      s.status,
      s.referenceTransactionId,
      s.failureCode,
      s.processedAt,
      s.observedBalance,
      s.referenceAttempts,
      s.nextReferenceAttemptAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }
  get referenceAttempts(): number {
    return this._referenceAttempts;
  }
  get nextReferenceAttemptAt(): Date | undefined {
    return this._nextReferenceAttemptAt;
  }

  // ---- transitions

  markProcessed(referenceTransactionId: string | undefined, at: Date, observedBalance: Money): void {
    this.assertNotTerminal("markProcessed");
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._observedBalance = observedBalance;
    this._nextReferenceAttemptAt = undefined;
  }

  markPendingReference(nextAttemptAt: Date, observedBalance: Money): void {
    if (this._status !== WagerTransactionStatus.Pending) {
      throw new InvalidTransactionStateError(`markPendingReference not allowed from ${this._status}`);
    }
    if (!this.referenceExternalTransactionId) {
      throw new InvalidTransactionStateError("Transaction has no reference to wait for");
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._nextReferenceAttemptAt = nextAttemptAt;
    this._observedBalance = observedBalance;
  }

  /** Records a failed resolution attempt while staying PENDING_REFERENCE. */
  scheduleReferenceRetry(nextAttemptAt: Date): void {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(`scheduleReferenceRetry not allowed from ${this._status}`);
    }
    this._referenceAttempts += 1;
    this._nextReferenceAttemptAt = nextAttemptAt;
  }

  reject(code: FailureCode, at: Date, observedBalance: Money): void {
    this.assertNotTerminal("reject");
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._processedAt = at;
    this._observedBalance = observedBalance;
    this._nextReferenceAttemptAt = undefined;
  }

  fail(code: FailureCode, at: Date): void {
    this.assertNotTerminal("fail");
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = at;
    this._nextReferenceAttemptAt = undefined;
  }

  // ---- domain queries

  isTerminal(): boolean {
    return TERMINAL.has(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  hasReference(): boolean {
    return this.referenceExternalTransactionId !== undefined;
  }

  isReversal(): boolean {
    return this.requiresReference();
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback:
        if (!reference) {
          throw new InvalidTransactionStateError("ROLLBACK direction depends on the referenced transaction");
        }
        return oppositeDirection(reference.ledgerDirectionFor());
      case WagerTransactionKind.Loss:
        throw new InvalidTransactionStateError("LOSS does not move the balance");
    }
  }

  /**
   * Checks business rules between this operation and its referenced
   * transaction. "Already reversed" needs a repository lookup and is checked by
   * the application service.
   */
  checkReference(reference: WagerTransaction): ReferenceCheck {
    const allowed = ALLOWED_REFERENCE_KINDS[this.kind] ?? [];
    if (!allowed.includes(reference.kind)) {
      return { ok: false, wait: false, code: FailureCode.ReferenceInvalidKind };
    }
    const sameScope =
      reference.providerId === this.providerId &&
      reference.playerId === this.playerId &&
      reference.walletId === this.walletId &&
      reference.money.currency === this.money.currency &&
      reference.roundId === this.roundId;
    if (!sameScope) {
      return { ok: false, wait: false, code: FailureCode.ReferenceMismatch };
    }
    if (!reference.isTerminal()) {
      return { ok: false, wait: true };
    }
    if (reference.status !== WagerTransactionStatus.Processed) {
      return { ok: false, wait: false, code: FailureCode.ReferenceNotProcessed };
    }
    if (this.isReversal() && !reference.money.equals(this.money)) {
      return { ok: false, wait: false, code: FailureCode.ReferenceAmountMismatch };
    }
    return { ok: true };
  }

  toState(): WagerTransactionState {
    return {
      id: this.id,
      providerId: this.providerId,
      externalTransactionId: this.externalTransactionId,
      idempotencyKey: this.idempotencyKey,
      payloadHash: this.payloadHash,
      walletId: this.walletId,
      playerId: this.playerId,
      roundId: this.roundId,
      gameId: this.gameId,
      kind: this.kind,
      money: this.money,
      referenceExternalTransactionId: this.referenceExternalTransactionId,
      correlationId: this.correlationId,
      createdAt: this.createdAt,
      status: this._status,
      referenceTransactionId: this._referenceTransactionId,
      failureCode: this._failureCode,
      processedAt: this._processedAt,
      observedBalance: this._observedBalance,
      referenceAttempts: this._referenceAttempts,
      nextReferenceAttemptAt: this._nextReferenceAttemptAt,
    };
  }

  private assertNotTerminal(transition: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(`${transition} not allowed: transaction ${this.id} is ${this._status}`);
    }
  }
}
