import {
  type BeforeApplicationShutdown,
  type DynamicModule,
  Inject,
  Injectable,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { MikroORM } from "@mikro-orm/postgresql";
import { CLOCK, type Clock, systemClock } from "./application/ports/clock";
import { UNIT_OF_WORK, type UnitOfWork } from "./application/ports/repositories";
import { OpenWallet } from "./application/use-cases/open-wallet";
import { WageringQueries } from "./application/use-cases/queries";
import { ReconcileWallet } from "./application/use-cases/reconcile-wallet";
import { ResolvePendingReferences } from "./application/use-cases/resolve-pending-references";
import { SubmitWagerTransaction } from "./application/use-cases/submit-wager-transaction";
import { WagerDecisionService } from "./application/wager-decision";
import { type JsonLogger, logger } from "./infrastructure/observability/logger";
import { PrometheusMetrics } from "./infrastructure/observability/metrics";
import { buildOrmConfig } from "./infrastructure/persistence/mikro-orm.config";
import { MikroOrmUnitOfWork } from "./infrastructure/persistence/mikro-orm-unit-of-work";
import { OutboxPublisher } from "./infrastructure/sqs/outbox-publisher";
import { SqsGateway } from "./infrastructure/sqs/sqs-gateway";
import { PollingWorker } from "./infrastructure/workers/polling-worker";
import { AuthGuard, NoopProviderIdentity, OidcProviderIdentity } from "./interface/http/auth";
import { AuthController } from "./interface/http/auth.controller";
import { ErrorFilter } from "./interface/http/error.filter";
import { OpsController } from "./interface/http/ops.controller";
import { LOGGER, METRICS, ORM, PROVIDER_IDENTITY, SQS_GATEWAY } from "./interface/http/tokens";
import { WageringController } from "./interface/http/wagering.controller";
import { WalletsController } from "./interface/http/wallets.controller";
import { WagerConsumer } from "./interface/sqs/wager-consumer";
import { APP_CONFIG, type AppConfig } from "./shared/config";

/** Starts background workers after boot, stops them (consumer first) before shutdown. */
@Injectable()
class BackgroundWorkers implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown {
  private readonly pollers: PollingWorker[] = [];

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(WagerConsumer) private readonly consumer: WagerConsumer,
    @Inject(OutboxPublisher) private readonly publisher: OutboxPublisher,
    @Inject(ResolvePendingReferences) private readonly resolver: ResolvePendingReferences,
    @Inject(ORM) private readonly orm: MikroORM,
    @Inject(LOGGER) private readonly log: JsonLogger,
  ) {}

  onApplicationBootstrap(): void {
    const w = this.config.workers;
    if (w.consumerEnabled) this.consumer.start();
    if (w.outboxEnabled) {
      this.pollers.push(
        new PollingWorker("outbox-publisher", w.outboxPollMs, async () => (await this.publisher.publishBatch()).claimed > 0, this.log),
      );
    }
    if (w.pendingReferenceEnabled) {
      this.pollers.push(
        new PollingWorker(
          "pending-reference-resolver",
          w.pendingReferencePollMs,
          async () => (await this.resolver.runOnce(50)).examined > 0,
          this.log,
        ),
      );
    }
    for (const poller of this.pollers) poller.start();
  }

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    this.log.info("shutting down", { signal });
    await this.consumer.stop();
    await Promise.all(this.pollers.map((p) => p.stop()));
  }

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close();
  }
}

@Module({})
export class AppModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [AuthController, WalletsController, WageringController, OpsController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: LOGGER, useValue: logger },
        { provide: CLOCK, useValue: systemClock },
        { provide: METRICS, useValue: new PrometheusMetrics() },
        {
          provide: PROVIDER_IDENTITY,
          useFactory: () =>
            config.auth.enabled
              ? new OidcProviderIdentity(config.auth)
              : new NoopProviderIdentity(config.auth.operatorRole),
        },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: ErrorFilter },
        {
          provide: ORM,
          useFactory: () => MikroORM.init(buildOrmConfig(config)),
        },
        {
          provide: SQS_GATEWAY,
          useFactory: async () => {
            const gateway = new SqsGateway(config.sqs);
            await gateway.init();
            return gateway;
          },
        },
        {
          provide: UNIT_OF_WORK,
          inject: [ORM],
          useFactory: (orm: MikroORM) =>
            new MikroOrmUnitOfWork(orm, {
              lockTimeoutMs: config.db.lockTimeoutMs,
              statementTimeoutMs: config.db.statementTimeoutMs,
            }),
        },
        {
          provide: WagerDecisionService,
          useFactory: () =>
            new WagerDecisionService({
              baseDelayMs: config.workers.referenceBaseDelayMs,
              maxDelayMs: config.workers.referenceMaxDelayMs,
              maxAttempts: config.workers.referenceMaxAttempts,
            }),
        },
        {
          provide: SubmitWagerTransaction,
          inject: [UNIT_OF_WORK, WagerDecisionService, CLOCK, METRICS],
          useFactory: (uow: UnitOfWork, d: WagerDecisionService, clock: Clock, m: PrometheusMetrics) =>
            new SubmitWagerTransaction(uow, d, clock, m, config.db.transientRetries),
        },
        {
          provide: ResolvePendingReferences,
          inject: [UNIT_OF_WORK, WagerDecisionService, CLOCK, METRICS],
          useFactory: (uow: UnitOfWork, d: WagerDecisionService, clock: Clock, m: PrometheusMetrics) =>
            new ResolvePendingReferences(uow, d, clock, m, config.db.transientRetries),
        },
        {
          provide: OpenWallet,
          inject: [UNIT_OF_WORK, CLOCK],
          useFactory: (uow: UnitOfWork, clock: Clock) => new OpenWallet(uow, clock),
        },
        {
          provide: WageringQueries,
          inject: [UNIT_OF_WORK],
          useFactory: (uow: UnitOfWork) => new WageringQueries(uow),
        },
        {
          provide: ReconcileWallet,
          inject: [UNIT_OF_WORK, METRICS],
          useFactory: (uow: UnitOfWork, m: PrometheusMetrics) =>
            new ReconcileWallet(uow, m, (report) =>
              logger.error("wallet reconciliation divergence", {
                walletId: report.walletId,
                checkedEntries: report.checkedEntries,
                // the difference itself is an amount: logged only as a flag, details go to the response / alert
                consistent: report.consistent,
              }),
            ),
        },
        {
          provide: WagerConsumer,
          inject: [SQS_GATEWAY, SubmitWagerTransaction, METRICS],
          useFactory: (sqs: SqsGateway, submit: SubmitWagerTransaction, m: PrometheusMetrics) =>
            new WagerConsumer(
              sqs,
              submit,
              { ...config.sqs, consumerName: config.workers.consumerName, shutdownGraceMs: config.workers.shutdownGraceMs },
              config.chaos,
              m,
              logger,
            ),
        },
        {
          provide: OutboxPublisher,
          inject: [ORM, SQS_GATEWAY, METRICS],
          useFactory: (orm: MikroORM, sqs: SqsGateway, m: PrometheusMetrics) =>
            new OutboxPublisher(
              orm,
              sqs,
              {
                instanceId: config.instanceId,
                batchSize: config.workers.outboxBatchSize,
                leaseMs: config.workers.outboxLeaseMs,
                crashAfterPublishBeforeMark: config.chaos.crashAfterPublishBeforeMark,
              },
              m,
              logger,
            ),
        },
        BackgroundWorkers,
      ],
    };
  }
}
