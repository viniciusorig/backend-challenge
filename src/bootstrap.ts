import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { logger } from "./infrastructure/observability/logger";
import { correlationMiddleware } from "./interface/http/correlation.middleware";
import type { AppConfig } from "./shared/config";

export async function createApp(config: AppConfig): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.register(config), { logger, abortOnError: false });
  app.use(correlationMiddleware);
  app.enableShutdownHooks(["SIGTERM", "SIGINT"]);
  return app;
}
