import type { JsonLogger } from "../observability/logger";

/**
 * Runs `tick` in a loop: immediately again when it did work, after `idleMs`
 * when idle, with capped exponential backoff after errors. stop() waits for
 * the current tick to finish.
 */
export class PollingWorker {
  private running = false;
  private loop?: Promise<void>;
  private wake?: () => void;

  constructor(
    private readonly name: string,
    private readonly idleMs: number,
    private readonly tick: () => Promise<boolean>,
    private readonly log: JsonLogger,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
    this.log.info("worker started", { worker: this.name });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.wake?.();
    await this.loop;
    this.log.info("worker stopped", { worker: this.name });
  }

  private async run(): Promise<void> {
    let failures = 0;
    while (this.running) {
      let delay = this.idleMs;
      try {
        const didWork = await this.tick();
        failures = 0;
        if (didWork) delay = 0;
      } catch (error) {
        failures++;
        delay = Math.min(30_000, this.idleMs * 2 ** Math.min(failures, 6));
        this.log.warn("worker tick failed", { worker: this.name, error, failures });
      }
      if (delay > 0 && this.running) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delay);
          this.wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      }
    }
  }
}
