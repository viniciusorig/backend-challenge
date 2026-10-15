import { EntitySchema } from "@mikro-orm/core";

/*
 * Persistence records. They are plain data holders mapped with EntitySchema,
 * so the domain classes stay free of ORM types and decorators. Repositories
 * translate records <-> domain objects. Money columns are NUMERIC(20,2) and
 * are read as decimal *strings* (MikroORM DecimalType, mode "string"), then
 * parsed into `Money` — no float in between.
 */

export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balanceAmount!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  amount!: string;
  currency!: string;
  referenceExternalTransactionId?: string | null;
  referenceTransactionId?: string | null;
  status!: string;
  failureCode?: string | null;
  observedBalanceAmount?: string | null;
  referenceAttempts!: number;
  nextReferenceAttemptAt?: Date | null;
  correlationId!: string;
  createdAt!: Date;
  processedAt?: Date | null;
}

export class LedgerEntryRecord {
  id!: string;
  walletId!: string;
  transactionId!: string;
  direction!: string;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  walletVersion!: number;
  createdAt!: Date;
}

export class InboxRecord {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt?: Date | null;
  transactionId?: string | null;
}

export class OutboxRecord {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt!: Date;
  lockedUntil?: Date | null;
  lockedBy?: string | null;
  publishedAt?: Date | null;
  lastError?: string | null;
}

const money = { type: "decimal", precision: 20, scale: 2 } as const;
const ts = { type: "datetime", columnType: "timestamptz" } as const;
const nullable = { nullable: true } as const;

export const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: "wallets",
  properties: {
    id: { type: "uuid", primary: true },
    playerId: { type: "string" },
    currency: { type: "string" },
    balanceAmount: { ...money },
    version: { type: "integer" },
    createdAt: { ...ts },
    updatedAt: { ...ts },
  },
});

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: "wager_transactions",
  properties: {
    id: { type: "uuid", primary: true },
    providerId: { type: "string" },
    externalTransactionId: { type: "string" },
    idempotencyKey: { type: "string" },
    payloadHash: { type: "string" },
    walletId: { type: "uuid" },
    playerId: { type: "string" },
    roundId: { type: "string" },
    gameId: { type: "string" },
    kind: { type: "string" },
    amount: { ...money },
    currency: { type: "string" },
    referenceExternalTransactionId: { type: "string", ...nullable },
    referenceTransactionId: { type: "uuid", ...nullable },
    status: { type: "string" },
    failureCode: { type: "string", ...nullable },
    observedBalanceAmount: { ...money, ...nullable },
    referenceAttempts: { type: "integer" },
    nextReferenceAttemptAt: { ...ts, ...nullable },
    correlationId: { type: "string" },
    createdAt: { ...ts },
    processedAt: { ...ts, ...nullable },
  },
});

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRecord>({
  class: LedgerEntryRecord,
  tableName: "wallet_ledger_entries",
  properties: {
    id: { type: "uuid", primary: true },
    walletId: { type: "uuid" },
    transactionId: { type: "uuid" },
    direction: { type: "string" },
    amount: { ...money },
    currency: { type: "string" },
    balanceBefore: { ...money },
    balanceAfter: { ...money },
    walletVersion: { type: "integer" },
    createdAt: { ...ts },
  },
});

export const InboxSchema = new EntitySchema<InboxRecord>({
  class: InboxRecord,
  tableName: "inbox_messages",
  properties: {
    consumerName: { type: "string", primary: true },
    messageId: { type: "string", primary: true },
    payloadHash: { type: "string" },
    receivedAt: { ...ts },
    processedAt: { ...ts, ...nullable },
    transactionId: { type: "uuid", ...nullable },
  },
});

export const OutboxSchema = new EntitySchema<OutboxRecord>({
  class: OutboxRecord,
  tableName: "outbox_messages",
  properties: {
    id: { type: "uuid", primary: true },
    aggregateId: { type: "uuid" },
    eventType: { type: "string" },
    payload: { type: "json", columnType: "jsonb" },
    occurredAt: { ...ts },
    attempts: { type: "integer" },
    nextAttemptAt: { ...ts },
    lockedUntil: { ...ts, ...nullable },
    lockedBy: { type: "string", ...nullable },
    publishedAt: { ...ts, ...nullable },
    lastError: { type: "string", ...nullable },
  },
});

export const ALL_SCHEMAS = [WalletSchema, WagerTransactionSchema, LedgerEntrySchema, InboxSchema, OutboxSchema];
