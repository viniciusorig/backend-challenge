/**
 * Stable, machine readable rejection / failure codes.
 *
 * `retryable` tells a provider whether resubmitting the *same* operation later
 * can succeed. Because idempotency replays return the original result, a
 * provider that wants to "retry" a rejected operation must send a new
 * externalTransactionId — the rejection itself is final for that key.
 */
export enum FailureCode {
  // ---- balance
  InsufficientFunds = "INSUFFICIENT_FUNDS",
  ReversalInsufficientFunds = "REVERSAL_WOULD_OVERDRAW",
  // ---- request coherence
  CurrencyMismatch = "CURRENCY_MISMATCH",
  PlayerWalletMismatch = "PLAYER_WALLET_MISMATCH",
  // ---- reference resolution
  ReferenceNotFound = "REFERENCE_NOT_FOUND",
  ReferenceInvalidKind = "REFERENCE_INVALID_KIND",
  ReferenceMismatch = "REFERENCE_MISMATCH",
  ReferenceNotProcessed = "REFERENCE_NOT_PROCESSED",
  ReferenceAlreadyReversed = "REFERENCE_ALREADY_REVERSED",
  ReferenceAmountMismatch = "REFERENCE_AMOUNT_MISMATCH",
  // ---- infrastructure (status FAILED)
  ProcessingError = "PROCESSING_ERROR",
}

export interface FailureCodeInfo {
  description: string;
  /** What the provider should do. */
  providerAction: "FIX_AND_RESEND_WITH_NEW_ID" | "DO_NOT_RESEND" | "CONTACT_OPERATOR";
}

export const FAILURE_CODES: Record<FailureCode, FailureCodeInfo> = {
  [FailureCode.InsufficientFunds]: {
    description: "BET amount exceeds the wallet balance.",
    providerAction: "DO_NOT_RESEND",
  },
  [FailureCode.ReversalInsufficientFunds]: {
    description: "A ROLLBACK that debits the wallet would make the balance negative.",
    providerAction: "CONTACT_OPERATOR",
  },
  [FailureCode.CurrencyMismatch]: {
    description: "Operation currency differs from the wallet currency.",
    providerAction: "FIX_AND_RESEND_WITH_NEW_ID",
  },
  [FailureCode.PlayerWalletMismatch]: {
    description: "playerId does not own walletId.",
    providerAction: "FIX_AND_RESEND_WITH_NEW_ID",
  },
  [FailureCode.ReferenceNotFound]: {
    description: "Referenced transaction never arrived within the resolution window.",
    providerAction: "CONTACT_OPERATOR",
  },
  [FailureCode.ReferenceInvalidKind]: {
    description: "Referenced transaction kind cannot be targeted by this operation.",
    providerAction: "FIX_AND_RESEND_WITH_NEW_ID",
  },
  [FailureCode.ReferenceMismatch]: {
    description: "Referenced transaction belongs to another provider, player, wallet, currency or round.",
    providerAction: "FIX_AND_RESEND_WITH_NEW_ID",
  },
  [FailureCode.ReferenceNotProcessed]: {
    description: "Referenced transaction ended REJECTED/FAILED, so there is nothing to revert.",
    providerAction: "DO_NOT_RESEND",
  },
  [FailureCode.ReferenceAlreadyReversed]: {
    description: "Referenced transaction was already reverted.",
    providerAction: "DO_NOT_RESEND",
  },
  [FailureCode.ReferenceAmountMismatch]: {
    description: "Reversal amount differs from the referenced amount (partial reversals are not supported).",
    providerAction: "FIX_AND_RESEND_WITH_NEW_ID",
  },
  [FailureCode.ProcessingError]: {
    description: "Permanent infrastructure error while processing; kept for audit.",
    providerAction: "CONTACT_OPERATOR",
  },
};
