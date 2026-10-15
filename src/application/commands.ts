import { InvalidArgumentError } from "../domain/errors";
import { Money, type MoneyProps } from "../domain/money/money";
import {
  EXTERNAL_KINDS,
  type ExternalKind,
  OPENING_PROVIDER_ID,
  WagerTransactionKind,
} from "../domain/wagering/wager-transaction";
import { InvalidRequestError } from "./errors";
import { hashCanonical } from "./payload-hash";

/** Provider request, identical for HTTP and SQS entry points. */
export interface SubmitWagerCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

/** Validated command with parsed money and its payload hash. */
export interface ValidatedWagerCommand extends Omit<SubmitWagerCommand, "money" | "kind"> {
  kind: ExternalKind;
  money: Money;
  payloadHash: string;
}

/**
 * Business fields that identify the operation. The Idempotency-Key header and
 * any transport metadata (messageId, occurredAt, correlation ids) are NOT part
 * of the hash. The amount is normalized ("25.0" and "25.00" hash the same).
 */
export function wagerPayloadHash(cmd: Omit<ValidatedWagerCommand, "payloadHash" | "idempotencyKey">): string {
  return hashCanonical({
    providerId: cmd.providerId,
    externalTransactionId: cmd.externalTransactionId,
    playerId: cmd.playerId,
    walletId: cmd.walletId,
    roundId: cmd.roundId,
    gameId: cmd.gameId,
    kind: cmd.kind,
    money: cmd.money.toJSON(),
    referenceExternalTransactionId: cmd.referenceExternalTransactionId ?? null,
  });
}

export function validateWagerCommand(cmd: SubmitWagerCommand): ValidatedWagerCommand {
  if (!cmd.idempotencyKey || cmd.idempotencyKey.trim() === "") {
    throw new InvalidRequestError("Idempotency-Key is required");
  }
  if (cmd.providerId === OPENING_PROVIDER_ID) {
    throw new InvalidRequestError(`providerId "${OPENING_PROVIDER_ID}" is reserved`);
  }
  if (cmd.kind === WagerTransactionKind.Opening || !(EXTERNAL_KINDS as readonly string[]).includes(cmd.kind)) {
    throw new InvalidRequestError(`kind must be one of ${EXTERNAL_KINDS.join(", ")}`);
  }
  let money: Money;
  try {
    money = Money.from(cmd.money);
  } catch (error) {
    if (error instanceof InvalidArgumentError) throw new InvalidRequestError(error.message);
    throw error;
  }
  const base = {
    providerId: cmd.providerId,
    externalTransactionId: cmd.externalTransactionId,
    playerId: cmd.playerId,
    walletId: cmd.walletId,
    roundId: cmd.roundId,
    gameId: cmd.gameId,
    kind: cmd.kind as ExternalKind,
    money,
    referenceExternalTransactionId: cmd.referenceExternalTransactionId || undefined,
  };
  return { ...base, idempotencyKey: cmd.idempotencyKey, payloadHash: wagerPayloadHash(base) };
}
