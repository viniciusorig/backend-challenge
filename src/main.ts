import "reflect-metadata";
import { createApp } from "./bootstrap";
import { logger } from "./infrastructure/observability/logger";
import { loadConfig } from "./shared/config";

const config = loadConfig();
const app = await createApp(config);
await app.listen(config.http.port);
logger.info("wagering processor listening", { port: config.http.port });
