import { Controller, Get, Header, Inject, Res } from "@nestjs/common";
import type { MikroORM } from "@mikro-orm/postgresql";
import type { Response } from "express";
import type { PrometheusMetrics } from "../../infrastructure/observability/metrics";
import type { SqsGateway } from "../../infrastructure/sqs/sqs-gateway";
import { Public } from "./auth";
import { METRICS, ORM, SQS_GATEWAY } from "./tokens";

async function probe(check: () => Promise<unknown>, timeoutMs = 2_000): Promise<{ ok: boolean; error?: string }> {
  try {
    await Promise.race([
      check(),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs)),
    ]);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

@Public()
@Controller()
export class OpsController {
  constructor(
    @Inject(ORM) private readonly orm: MikroORM,
    @Inject(SQS_GATEWAY) private readonly sqs: SqsGateway,
    @Inject(METRICS) private readonly metrics: PrometheusMetrics,
  ) {}

  /** Liveness: the process answers. No dependency checks (a DB outage must not restart pods). */
  @Get("health/live")
  live() {
    return { status: "ok" };
  }

  /** Readiness: PostgreSQL and SQS reachable. */
  @Get("health/ready")
  async ready(@Res({ passthrough: true }) res: Response) {
    const [postgres, sqs] = await Promise.all([
      probe(() => this.orm.em.fork().execute("SELECT 1")),
      probe(() => this.sqs.ping()),
    ]);
    const ok = postgres.ok && sqs.ok;
    res.status(ok ? 200 : 503);
    return { status: ok ? "ok" : "unavailable", checks: { postgres, sqs } };
  }

  @Get("metrics")
  @Header("Content-Type", "text/plain; version=0.0.4")
  async prometheus() {
    return this.metrics.registry.metrics();
  }
}
