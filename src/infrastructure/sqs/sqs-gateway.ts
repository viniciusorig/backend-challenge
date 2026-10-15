import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import type { AppConfig } from "../../shared/config";

export interface QueueUrls {
  input: string;
  dlq: string;
  events: string;
}

/** Owns the SQS client and the queue URLs; creates the queues when allowed (local / tests). */
export class SqsGateway {
  readonly client: SQSClient;
  private urls?: QueueUrls;

  constructor(private readonly config: AppConfig["sqs"]) {
    this.client = new SQSClient({
      endpoint: config.endpoint,
      region: config.region,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      maxAttempts: 2,
    });
  }

  get queues(): QueueUrls {
    if (!this.urls) throw new Error("SQS queues not initialized");
    return this.urls;
  }

  async init(): Promise<QueueUrls> {
    this.urls = this.config.autoCreateQueues ? await this.ensureQueues() : await this.lookupQueues();
    return this.urls;
  }

  /** Readiness probe: the input queue answers. */
  async ping(): Promise<void> {
    await this.client.send(
      new GetQueueAttributesCommand({ QueueUrl: this.queues.input, AttributeNames: ["QueueArn"] }),
    );
  }

  private async lookupQueues(): Promise<QueueUrls> {
    const url = async (name: string) =>
      (await this.client.send(new GetQueueUrlCommand({ QueueName: name }))).QueueUrl!;
    return {
      input: await url(this.config.inputQueue),
      dlq: await url(this.config.dlqQueue),
      events: await url(this.config.eventsQueue),
    };
  }

  /** Idempotent CreateQueue for the FIFO input queue, its DLQ and the events queue. */
  private async ensureQueues(): Promise<QueueUrls> {
    const fifo = { FifoQueue: "true", ContentBasedDeduplication: "false" };
    const dlq = (await this.client.send(new CreateQueueCommand({ QueueName: this.config.dlqQueue, Attributes: fifo })))
      .QueueUrl!;
    const dlqArn = (
      await this.client.send(new GetQueueAttributesCommand({ QueueUrl: dlq, AttributeNames: ["QueueArn"] }))
    ).Attributes!.QueueArn!;
    const input = (
      await this.client.send(
        new CreateQueueCommand({
          QueueName: this.config.inputQueue,
          Attributes: {
            ...fifo,
            VisibilityTimeout: String(this.config.visibilityTimeoutSec),
            // Safety net only: the consumer moves exhausted messages itself at maxReceiveCount.
            // The broker redrive catches messages whose processing keeps crashing the process.
            RedrivePolicy: JSON.stringify({
              deadLetterTargetArn: dlqArn,
              maxReceiveCount: this.config.maxReceiveCount + 2,
            }),
          },
        }),
      )
    ).QueueUrl!;
    const events = (
      await this.client.send(new CreateQueueCommand({ QueueName: this.config.eventsQueue, Attributes: fifo }))
    ).QueueUrl!;
    return { input, dlq, events };
  }
}
