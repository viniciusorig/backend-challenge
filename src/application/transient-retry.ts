import { TransientInfrastructureError, UniqueViolationError } from "./errors";
import type { WageringMetrics } from "./ports/metrics";

/**
 * Re-runs a whole unit of work when it lost a race (unique violation) or hit a
 * transient database condition (lock timeout, deadlock, serialization). Each
 * attempt is a fresh SQL transaction, so retrying is always safe.
 */
export async function withTransientRetry<T>(
  operation: string,
  attempts: number,
  metrics: WageringMetrics,
  work: () => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await work();
    } catch (error) {
      const retryable =
        error instanceof UniqueViolationError ||
        (error instanceof TransientInfrastructureError && error.code !== "DATABASE_UNAVAILABLE");
      if (!retryable || attempt === attempts) throw error;
      lastError = error;
      if (error instanceof TransientInfrastructureError && error.code === "LOCK_TIMEOUT") metrics.lockConflict();
      metrics.retry(operation, (error as { code: string }).code);
      await Bun.sleep(Math.round(10 * 2 ** attempt * (0.5 + Math.random())));
    }
  }
  throw lastError;
}
