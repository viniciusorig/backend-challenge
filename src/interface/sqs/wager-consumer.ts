import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";
import { hashCanonical } from "../../application/payload-hash";
import type { SubmitWagerTransaction } from "../../application/use-cases/submit-wager-transaction";
import type { JsonLogger } from "../../infrastructure/observability/logger";
import { withLogContext } from "../../infrastructure/observability/logger";
import type { PrometheusMetrics } from "../../infrastructure/observability/metrics";
import type { SqsGateway } from "../../infrastructure/sqs/sqs-gateway";
import type { AppConfig } from "../../shared/config";
import { wagerMessageSchema } from "../contracts";
import { classifyError } from "../error-classification";

type Disposition =
  | { action: "ack"; outcome: string }
  | { action: "retry"; reason: string }
  | { action: "dlq"; reason: string; code: string };

/**
 * Consumes `wager-transactions.fifo` and feeds the same use case as HTTP.
 *
 *  - de-duplication: inbox row (consumerName, envelope messageId) written in
 *    the same SQL transaction as the financial effect;
 *  - ack (DeleteMessage) only after the use case committed;
 *  - business outcomes (PROCESSED / REJECTED / PENDING_REFERENCE) → ack;
 *  - transient errors → keep the message, push visibility out with
 *    exponential backoff; after `maxReceiveCount` receives → DLQ;
 *  - permanent errors (malformed, unknown wallet, idempotency conflict) → DLQ now;
 *  - FIFO groups (walletId) are processed sequentially, different groups in parallel;
 *  - stop(): no new receives, in-flight messages finish, not-yet-started ones
 *    get their visibility reset to 0 so another instance takes them at once.
 */
export class WagerConsumer {
  private running = false;
  private loop?: Promise<void>;
  private abort?: AbortController;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly sqs: SqsGateway,
    private readonly submit: SubmitWagerTransaction,
    private readonly config: AppConfig["sqs"] & { consumerName: string; shutdownGraceMs: number },
    private readonly chaos: AppConfig["chaos"],
    private readonly metrics: PrometheusMetrics,
    private readonly log: JsonLogger,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
    this.log.info("sqs consumer started", { queue: this.config.inputQueue });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.abort?.abort();
    await this.loop?.catch(() => {});
    const grace = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), this.config.shutdownGraceMs));
    const drained = await Promise.race([Promise.allSettled([...this.inFlight]).then(() => "drained" as const), grace]);
    this.log.info("sqs consumer stopped", { drained });
  }

  private async run(): Promise<void> {
    let failures = 0;
    while (this.running) {
      try {
        this.abort = new AbortController();
        const response = await this.sqs.client.send(
          new ReceiveMessageCommand({
            QueueUrl: this.sqs.queues.input,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: this.config.waitTimeSec,
            VisibilityTimeout: this.config.visibilityTimeoutSec,
            MessageSystemAttributeNames: ["ApproximateReceiveCount", "MessageGroupId"],
          }),
          { abortSignal: this.abort.signal },
        );
        failures = 0;
        const messages = response.Messages ?? [];
        if (messages.length === 0) continue;
        const batch = this.processBatch(messages);
        this.inFlight.add(batch);
        // Wait for the batch: FIFO will not hand out more messages of these groups until they are acked anyway.
        await batch.finally(() => this.inFlight.delete(batch));
      } catch (error) {
        if (!this.running) break;
        failures++;
        this.log.warn("sqs receive failed", { error, failures });
        await Bun.sleep(Math.min(30_000, 500 * 2 ** Math.min(failures, 6)));
      }
    }
  }

  private async processBatch(messages: Message[]): Promise<void> {
    const groups = new Map<string, Message[]>();
    for (const m of messages) {
      const group = m.Attributes?.MessageGroupId ?? m.MessageId ?? "default";
      groups.set(group, [...(groups.get(group) ?? []), m]);
    }
    await Promise.all(
      [...groups.values()].map(async (group) => {
        for (const message of group) {
          if (!this.running) {
            await this.release(message);
            continue;
          }
          await this.handle(message);
        }
      }),
    );
  }

  private async handle(message: Message): Promise<void> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? "1");
    let envelope: ReturnType<typeof wagerMessageSchema.parse> | undefined;
    let disposition: Disposition;
    const startedAt = performance.now();

    try {
      envelope = wagerMessageSchema.parse(JSON.parse(message.Body ?? ""));
    } catch (error) {
      const classified = classifyError(error);
      disposition = { action: "dlq", reason: "MALFORMED_MESSAGE", code: classified.code };
      return this.settle(message, disposition, receiveCount);
    }

    const { data, messageId } = envelope;
    const correlationId = envelope.correlationId ?? messageId;
    await withLogContext(
      { correlationId, messageId, walletId: data.walletId, providerId: data.providerId },
      async () => {
        try {
          const { idempotencyKey, ...business } = data;
          const result = await this.submit.execute(
            { ...business, idempotencyKey },
            {
              source: "sqs",
              correlationId,
              causationId: messageId,
              inbox: {
                consumerName: this.config.consumerName,
                messageId,
                // Transport metadata (occurredAt, correlationId) is excluded, like for HTTP.
                payloadHash: hashCanonical({ type: envelope!.type, data }),
              },
            },
          );
          this.log.info("wager message processed", {
            transactionId: result.transaction.id,
            status: result.transaction.status,
            failureCode: result.transaction.failureCode,
            idempotentReplay: result.idempotentReplay,
            duplicateMessage: result.duplicateMessage,
            receiveCount,
            durationMs: Math.round(performance.now() - startedAt),
          });
          if (this.chaos.crashAfterCommitBeforeAck) {
            this.log.warn("CHAOS: crashing after commit, before ack");
            process.exit(137);
          }
          disposition = { action: "ack", outcome: result.duplicateMessage ? "duplicate" : result.transaction.status };
        } catch (error) {
          const classified = classifyError(error);
          if (classified.kind === "transient" || classified.kind === "internal") {
            disposition =
              receiveCount >= this.config.maxReceiveCount
                ? { action: "dlq", reason: "RETRIES_EXHAUSTED", code: classified.code }
                : { action: "retry", reason: classified.code };
            this.log.warn("wager message failed", { error, code: classified.code, receiveCount });
          } else {
            disposition = { action: "dlq", reason: "PERMANENT_ERROR", code: classified.code };
            this.log.warn("wager message rejected permanently", { code: classified.code, receiveCount });
          }
        }
        await this.settle(message, disposition, receiveCount);
      },
    );
  }

  private async settle(message: Message, disposition: Disposition, receiveCount: number): Promise<void> {
    try {
      switch (disposition.action) {
        case "ack":
          await this.delete(message);
          this.metrics.sqsMessages.inc({ outcome: disposition.outcome === "duplicate" ? "duplicate" : "acked" });
          return;
        case "retry": {
          // Exponential backoff through the visibility timeout (max 12h in SQS).
          const delay = Math.min(43_200, this.config.retryBaseDelaySec * 2 ** Math.max(0, receiveCount - 1));
          await this.sqs.client.send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: this.sqs.queues.input,
              ReceiptHandle: message.ReceiptHandle!,
              VisibilityTimeout: delay,
            }),
          );
          this.metrics.sqsMessages.inc({ outcome: "retried" });
          this.metrics.retries.inc({ operation: "sqs_message", reason: disposition.reason });
          return;
        }
        case "dlq":
          await this.sqs.client.send(
            new SendMessageCommand({
              QueueUrl: this.sqs.queues.dlq,
              MessageBody: message.Body ?? "",
              MessageGroupId: message.Attributes?.MessageGroupId ?? "dlq",
              MessageDeduplicationId: message.MessageId!,
              MessageAttributes: {
                failureReason: { DataType: "String", StringValue: disposition.reason },
                errorCode: { DataType: "String", StringValue: disposition.code },
                receiveCount: { DataType: "Number", StringValue: String(receiveCount) },
                consumer: { DataType: "String", StringValue: this.config.consumerName },
              },
            }),
          );
          await this.delete(message);
          this.metrics.dlqMessages.inc({ reason: disposition.reason });
          this.metrics.sqsMessages.inc({ outcome: "dead_lettered" });
          this.log.warn("message moved to DLQ", { reason: disposition.reason, code: disposition.code, receiveCount });
          return;
      }
    } catch (error) {
      // Not acked → the message reappears after the visibility timeout; the inbox makes that safe.
      this.log.error("failed to settle sqs message", { error, action: disposition.action });
    }
  }

  private async delete(message: Message): Promise<void> {
    await this.sqs.client.send(
      new DeleteMessageCommand({ QueueUrl: this.sqs.queues.input, ReceiptHandle: message.ReceiptHandle! }),
    );
  }

  /** Gives a received-but-not-started message back to the queue immediately. */
  private async release(message: Message): Promise<void> {
    try {
      await this.sqs.client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.sqs.queues.input,
          ReceiptHandle: message.ReceiptHandle!,
          VisibilityTimeout: 0,
        }),
      );
    } catch (error) {
      this.log.warn("failed to release message on shutdown", { error });
    }
  }
}
