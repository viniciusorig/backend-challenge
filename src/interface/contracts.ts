import { z } from "zod";

/** Input contracts shared by HTTP and SQS. Money format is validated by `Money.from`. */
export const moneySchema = z
  .object({
    amount: z.string({ invalid_type_error: "amount must be a decimal string" }),
    currency: z.string(),
  })
  .strict();

const id = (max: number) => z.string().trim().min(1).max(max);

export const wagerRequestSchema = z
  .object({
    providerId: id(64),
    externalTransactionId: id(128),
    playerId: id(128),
    walletId: z.string().uuid(),
    roundId: id(128),
    gameId: id(128),
    kind: z.enum(["BET", "WIN", "LOSS", "REFUND", "ROLLBACK"]),
    money: moneySchema,
    referenceExternalTransactionId: id(128).optional(),
  })
  .strict();
export type WagerRequest = z.infer<typeof wagerRequestSchema>;

export const wagerMessageSchema = z.object({
  messageId: id(128),
  type: z.literal("WagerTransactionRequested"),
  occurredAt: z.string().datetime({ offset: true }),
  correlationId: id(128).optional(),
  data: wagerRequestSchema.extend({ idempotencyKey: id(255) }).strict(),
});
export type WagerMessage = z.infer<typeof wagerMessageSchema>;

export const openWalletSchema = z
  .object({
    playerId: id(128),
    initialBalance: moneySchema,
  })
  .strict();
