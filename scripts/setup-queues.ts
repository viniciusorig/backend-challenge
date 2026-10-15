/** Creates the FIFO queues (input, DLQ with redrive, events). Idempotent. */
import { SqsGateway } from "../src/infrastructure/sqs/sqs-gateway";
import { loadConfig } from "../src/shared/config";

const config = loadConfig();
const urls = await new SqsGateway({ ...config.sqs, autoCreateQueues: true }).init();
console.log(JSON.stringify(urls, null, 2));
