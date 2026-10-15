import { describe, expect, test } from "bun:test";
import { canonicalJson, hashCanonical } from "../../src/application/payload-hash";
import { wagerPayloadHash } from "../../src/application/commands";
import { WalletBalanceChanged } from "../../src/domain/events/wagering-events";
import { InvalidTransactionStateError } from "../../src/domain/errors";
import { InboxMessage } from "../../src/domain/messaging/inbox-message";
import { OutboxMessage, backoffDelayMs } from "../../src/domain/messaging/outbox-message";
import { Money } from "../../src/domain/money/money";
import { Wallet } from "../../src/domain/wallet/wallet";
import { WagerTransactionKind } from "../../src/domain/wagering/wager-transaction";

const at = new Date("2026-01-01T00:00:00Z");

describe("canonical JSON / payload hash", () => {
  test("key order does not matter, values do", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, 2], c: "x" } })).toBe('{"a":{"c":"x","d":[1,2]},"b":1}');
    expect(hashCanonical({ a: 1, b: 2 })).toBe(hashCanonical({ b: 2, a: 1 }));
    expect(hashCanonical({ a: 1 })).not.toBe(hashCanonical({ a: 2 }));
    expect(hashCanonical({ a: 1, skip: undefined })).toBe(hashCanonical({ a: 1 }));
  });

  test("wager hash covers business fields only", () => {
    const base = {
      providerId: "p",
      externalTransactionId: "e",
      playerId: "pl",
      walletId: "w",
      roundId: "r",
      gameId: "g",
      kind: WagerTransactionKind.Bet as const,
      money: Money.from({ amount: "1.00", currency: "BRL" }),
    };
    expect(wagerPayloadHash(base)).toMatch(/^[0-9a-f]{64}$/);
    expect(wagerPayloadHash(base)).not.toBe(wagerPayloadHash({ ...base, roundId: "r2" }));
  });
});

describe("Inbox / Outbox", () => {
  test("inbox processes once", () => {
    const m = InboxMessage.receive({ messageId: "m", consumerName: "c", payloadHash: "h", receivedAt: at });
    expect(m.isProcessed()).toBe(false);
    m.markProcessed(at);
    expect(m.isProcessed()).toBe(true);
    expect(() => m.markProcessed(at)).toThrow(InvalidTransactionStateError);
  });

  test("outbox envelope, retries with backoff, publish once", () => {
    const { wallet, openingEntry } = Wallet.open({
      id: "w",
      playerId: "p",
      initialBalance: Money.from({ amount: "5.00", currency: "BRL" }),
      openingTransactionId: "t",
      openingEntryId: "e",
      at,
    });
    const event = WalletBalanceChanged.from(wallet, openingEntry!, { correlationId: "c", occurredAt: at, newEventId: () => "ev-1" });
    const msg = OutboxMessage.enqueue(event);
    expect(msg.id).toBe("ev-1");
    expect(msg.payload).toMatchObject({
      eventId: "ev-1",
      eventType: "WalletBalanceChanged",
      version: 1,
      occurredAt: at.toISOString(),
      data: { money: { amount: "5.00", currency: "BRL" }, walletVersion: 1 },
    });
    expect(msg.isDue(at)).toBe(true);
    msg.scheduleRetry(at);
    expect(msg.attempts).toBe(1);
    expect(msg.isDue(at)).toBe(false);
    msg.markPublished(at);
    expect(msg.isPending()).toBe(false);
    expect(() => msg.markPublished(at)).toThrow(InvalidTransactionStateError);
  });

  test("backoff grows exponentially and is capped", () => {
    const policy = { baseDelayMs: 100, maxDelayMs: 1000 };
    const max = () => 1;
    expect(backoffDelayMs(1, policy, max)).toBe(100);
    expect(backoffDelayMs(2, policy, max)).toBe(200);
    expect(backoffDelayMs(3, policy, max)).toBe(400);
    expect(backoffDelayMs(10, policy, max)).toBe(1000);
  });
});
