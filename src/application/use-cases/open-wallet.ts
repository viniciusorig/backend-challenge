import { WagerTransactionProcessed, WalletBalanceChanged } from "../../domain/events/wagering-events";
import { InvalidArgumentError } from "../../domain/errors";
import { OutboxMessage } from "../../domain/messaging/outbox-message";
import { Money, type MoneyProps } from "../../domain/money/money";
import { WagerTransaction } from "../../domain/wagering/wager-transaction";
import { Wallet } from "../../domain/wallet/wallet";
import { newId } from "../../shared/ids";
import { InvalidRequestError, UniqueViolationError, WalletAlreadyExistsError } from "../errors";
import type { Clock } from "../ports/clock";
import type { UnitOfWork } from "../ports/repositories";

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
}

/**
 * Creates a wallet. A positive initial balance becomes an internal OPENING
 * transaction + CREDIT ledger line + events, all in the same SQL transaction.
 */
export class OpenWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(cmd: OpenWalletCommand, correlationId: string): Promise<Wallet> {
    let initialBalance: Money;
    try {
      initialBalance = Money.from(cmd.initialBalance);
    } catch (error) {
      if (error instanceof InvalidArgumentError) throw new InvalidRequestError(error.message);
      throw error;
    }

    try {
      return await this.uow.transactional(async (store) => {
        const existing = await store.wallets.findByPlayerAndCurrency(cmd.playerId, initialBalance.currency);
        if (existing) throw new WalletAlreadyExistsError(cmd.playerId, initialBalance.currency);

        const now = this.clock.now();
        const openingTransactionId = newId();
        const { wallet, openingEntry } = Wallet.open({
          id: newId(),
          playerId: cmd.playerId,
          initialBalance,
          openingTransactionId,
          openingEntryId: newId(),
          at: now,
        });
        await store.wallets.insert(wallet);

        if (openingEntry) {
          const opening = WagerTransaction.opening({
            id: openingTransactionId,
            walletId: wallet.id,
            playerId: wallet.playerId,
            money: initialBalance,
            correlationId,
            at: now,
          });
          const events = { correlationId, occurredAt: now, newEventId: newId };
          await store.transactions.insert(opening);
          await store.ledger.insert(openingEntry);
          await store.outbox.add(OutboxMessage.enqueue(WagerTransactionProcessed.from(opening, events)));
          await store.outbox.add(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, openingEntry, events)));
        }
        return wallet;
      });
    } catch (error) {
      // Lost the race against a concurrent creation for the same player + currency.
      if (error instanceof UniqueViolationError && error.constraint === "wallets_player_currency_uq") {
        throw new WalletAlreadyExistsError(cmd.playerId, initialBalance.currency);
      }
      throw error;
    }
  }
}
