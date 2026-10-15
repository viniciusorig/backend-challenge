/** What the application layer reports; implemented with prom-client in infrastructure. */
export interface WageringMetrics {
  transactionFinished(kind: string, status: string, source: RequestSource, durationSeconds: number): void;
  duplicateDetected(kind: "idempotency_replay" | "inbox_message", source: RequestSource): void;
  retry(operation: string, reason: string): void;
  lockConflict(): void;
  reconciliationChecked(consistent: boolean): void;
}

export type RequestSource = "http" | "sqs" | "worker";

export const WAGERING_METRICS = Symbol("WAGERING_METRICS");

export const noopMetrics: WageringMetrics = {
  transactionFinished: () => {},
  duplicateDetected: () => {},
  retry: () => {},
  lockConflict: () => {},
  reconciliationChecked: () => {},
};
