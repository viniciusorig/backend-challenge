import { Migration } from "@mikro-orm/migrations";

/**
 * Initial schema. Invariants live here, not only in application code:
 *
 *  - money is NUMERIC(20,2) (exact decimal), never float;
 *  - one wallet per (player_id, currency); balance >= 0 (CHECK);
 *  - wallet.version bumps by exactly 1 iff the balance changes (trigger);
 *  - every wallet version > 1 (or any positive balance) has a matching ledger
 *    line whose balance_after equals the wallet balance (deferred constraint
 *    trigger, checked at COMMIT) — balance and ledger cannot diverge;
 *  - ledger lines are arithmetically balanced (CHECK), chained
 *    (balance_before = previous balance_after) and append-only (triggers block
 *    UPDATE / DELETE / TRUNCATE);
 *  - at most one ledger line per (transaction, wallet);
 *  - idempotency key and (provider, external id) are unique;
 *  - a transaction is reverted at most once (partial unique index);
 *  - terminal transactions are frozen and business columns are immutable (trigger);
 *  - inbox de-duplicates by (consumer_name, message_id) (PK).
 */
export class Migration20261014000001_initial_schema extends Migration {
  override async up(): Promise<void> {
    // ------------------------------------------------------------------ wallets
    this.addSql(`
      CREATE TABLE wallets (
        id              uuid           PRIMARY KEY,
        player_id       varchar(128)   NOT NULL,
        currency        char(3)        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        balance_amount  numeric(20,2)  NOT NULL CONSTRAINT wallets_balance_non_negative_ck CHECK (balance_amount >= 0),
        version         integer        NOT NULL CHECK (version >= 1),
        created_at      timestamptz    NOT NULL,
        updated_at      timestamptz    NOT NULL,
        CONSTRAINT wallets_player_currency_uq UNIQUE (player_id, currency)
      )`);

    // -------------------------------------------------------- wager transactions
    this.addSql(`
      CREATE TABLE wager_transactions (
        id                                uuid           PRIMARY KEY,
        provider_id                       varchar(64)    NOT NULL,
        external_transaction_id           varchar(128)   NOT NULL,
        idempotency_key                   varchar(255)   NOT NULL,
        payload_hash                      varchar(64)    NOT NULL,
        wallet_id                         uuid           NOT NULL REFERENCES wallets(id) DEFERRABLE INITIALLY DEFERRED,
        player_id                         varchar(128)   NOT NULL,
        round_id                          varchar(128)   NOT NULL,
        game_id                           varchar(128)   NOT NULL,
        kind                              varchar(16)    NOT NULL CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        amount                            numeric(20,2)  NOT NULL CHECK (amount >= 0),
        currency                          char(3)        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        reference_external_transaction_id varchar(128),
        reference_transaction_id          uuid           REFERENCES wager_transactions(id) DEFERRABLE INITIALLY DEFERRED,
        status                            varchar(24)    NOT NULL CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        failure_code                      varchar(64),
        observed_balance_amount           numeric(20,2)  CHECK (observed_balance_amount >= 0),
        reference_attempts                integer        NOT NULL DEFAULT 0 CHECK (reference_attempts >= 0),
        next_reference_attempt_at         timestamptz,
        correlation_id                    varchar(128)   NOT NULL,
        created_at                        timestamptz    NOT NULL,
        processed_at                      timestamptz,
        CONSTRAINT wager_tx_idempotency_key_uq   UNIQUE (idempotency_key),
        CONSTRAINT wager_tx_provider_external_uq UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT wager_tx_reference_required_ck CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CONSTRAINT wager_tx_amount_positive_ck   CHECK (kind = 'LOSS' OR amount > 0),
        CONSTRAINT wager_tx_opening_internal_ck  CHECK ((kind = 'OPENING') = (provider_id = '__internal__')),
        CONSTRAINT wager_tx_failure_code_ck      CHECK ((status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)),
        CONSTRAINT wager_tx_terminal_has_time_ck CHECK (status NOT IN ('PROCESSED','REJECTED','FAILED') OR processed_at IS NOT NULL),
        CONSTRAINT wager_tx_pending_ref_due_ck   CHECK (status <> 'PENDING_REFERENCE' OR next_reference_attempt_at IS NOT NULL)
      )`);
    // A referenced transaction can be reverted (REFUND or ROLLBACK) only once.
    this.addSql(`
      CREATE UNIQUE INDEX wager_tx_single_reversal_uq ON wager_transactions (reference_transaction_id)
      WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')`);
    this.addSql(`
      CREATE INDEX wager_tx_pending_reference_due_idx ON wager_transactions (next_reference_attempt_at)
      WHERE status = 'PENDING_REFERENCE'`);
    this.addSql(`
      CREATE INDEX wager_tx_waiting_on_idx ON wager_transactions (provider_id, reference_external_transaction_id)
      WHERE status = 'PENDING_REFERENCE'`);
    this.addSql(`CREATE INDEX wager_tx_wallet_created_idx ON wager_transactions (wallet_id, created_at)`);

    this.addSql(`
      CREATE FUNCTION wager_tx_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'wager_transactions rows cannot be deleted' USING ERRCODE = 'restrict_violation';
        END IF;
        IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
          RAISE EXCEPTION 'wager transaction % is terminal (%)', OLD.id, OLD.status USING ERRCODE = 'restrict_violation';
        END IF;
        IF (NEW.id, NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key, NEW.payload_hash,
            NEW.wallet_id, NEW.player_id, NEW.round_id, NEW.game_id, NEW.kind, NEW.amount, NEW.currency,
            NEW.reference_external_transaction_id, NEW.correlation_id, NEW.created_at)
           IS DISTINCT FROM
           (OLD.id, OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key, OLD.payload_hash,
            OLD.wallet_id, OLD.player_id, OLD.round_id, OLD.game_id, OLD.kind, OLD.amount, OLD.currency,
            OLD.reference_external_transaction_id, OLD.correlation_id, OLD.created_at) THEN
          RAISE EXCEPTION 'wager transaction % business columns are immutable', OLD.id USING ERRCODE = 'restrict_violation';
        END IF;
        IF NEW.status = 'PENDING' AND OLD.status <> 'PENDING' THEN
          RAISE EXCEPTION 'invalid transition % -> PENDING', OLD.status USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
      END $$`);
    this.addSql(`
      CREATE TRIGGER wager_tx_guard_trg BEFORE UPDATE OR DELETE ON wager_transactions
      FOR EACH ROW EXECUTE FUNCTION wager_tx_guard()`);

    // ------------------------------------------------------------------- ledger
    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id              uuid           PRIMARY KEY,
        wallet_id       uuid           NOT NULL REFERENCES wallets(id) DEFERRABLE INITIALLY DEFERRED,
        transaction_id  uuid           NOT NULL REFERENCES wager_transactions(id) DEFERRABLE INITIALLY DEFERRED,
        direction       varchar(6)     NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
        amount          numeric(20,2)  NOT NULL CHECK (amount > 0),
        currency        char(3)        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        balance_before  numeric(20,2)  NOT NULL CHECK (balance_before >= 0),
        balance_after   numeric(20,2)  NOT NULL CHECK (balance_after >= 0),
        wallet_version  integer        NOT NULL CHECK (wallet_version >= 1),
        created_at      timestamptz    NOT NULL,
        CONSTRAINT ledger_transaction_wallet_uq UNIQUE (transaction_id, wallet_id),
        CONSTRAINT ledger_wallet_version_uq     UNIQUE (wallet_id, wallet_version),
        CONSTRAINT ledger_balanced_ck CHECK (
          balance_after = CASE direction WHEN 'CREDIT' THEN balance_before + amount ELSE balance_before - amount END
        )
      )`);

    // Append-only.
    this.addSql(`
      CREATE FUNCTION ledger_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is append-only (% rejected)', TG_OP USING ERRCODE = 'restrict_violation';
      END $$`);
    this.addSql(`
      CREATE TRIGGER ledger_no_update_delete_trg BEFORE UPDATE OR DELETE ON wallet_ledger_entries
      FOR EACH ROW EXECUTE FUNCTION ledger_append_only()`);
    this.addSql(`
      CREATE TRIGGER ledger_no_truncate_trg BEFORE TRUNCATE ON wallet_ledger_entries
      FOR EACH STATEMENT EXECUTE FUNCTION ledger_append_only()`);

    // Chain: each line starts where the previous one ended, versions are contiguous.
    this.addSql(`
      CREATE FUNCTION ledger_chain_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        prev record;
        wallet_currency char(3);
      BEGIN
        SELECT currency INTO wallet_currency FROM wallets WHERE id = NEW.wallet_id;
        IF wallet_currency IS NOT NULL AND wallet_currency <> NEW.currency THEN
          RAISE EXCEPTION 'ledger currency % differs from wallet currency %', NEW.currency, wallet_currency
            USING ERRCODE = 'check_violation';
        END IF;
        SELECT balance_after, wallet_version INTO prev
          FROM wallet_ledger_entries WHERE wallet_id = NEW.wallet_id
          ORDER BY wallet_version DESC LIMIT 1;
        IF NOT FOUND THEN
          IF NEW.balance_before <> 0 OR NEW.wallet_version NOT IN (1, 2) THEN
            RAISE EXCEPTION 'first ledger line of wallet % must start at 0 with version 1 or 2', NEW.wallet_id
              USING ERRCODE = 'check_violation';
          END IF;
        ELSIF NEW.balance_before <> prev.balance_after OR NEW.wallet_version <> prev.wallet_version + 1 THEN
          RAISE EXCEPTION 'ledger chain broken for wallet % (expected before=% version=%)',
            NEW.wallet_id, prev.balance_after, prev.wallet_version + 1 USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$`);
    this.addSql(`
      CREATE TRIGGER ledger_chain_guard_trg BEFORE INSERT ON wallet_ledger_entries
      FOR EACH ROW EXECUTE FUNCTION ledger_chain_guard()`);

    // A ledger line can never be ahead of its wallet (checked at COMMIT).
    this.addSql(`
      CREATE FUNCTION ledger_matches_wallet() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM wallets WHERE id = NEW.wallet_id AND version >= NEW.wallet_version) THEN
          RAISE EXCEPTION 'ledger line % has no matching wallet version', NEW.id USING ERRCODE = 'check_violation';
        END IF;
        RETURN NULL;
      END $$`);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER ledger_matches_wallet_trg AFTER INSERT ON wallet_ledger_entries
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_matches_wallet()`);

    // Wallet: identity columns immutable, version bumps iff balance changes, no delete.
    this.addSql(`
      CREATE FUNCTION wallet_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'wallets cannot be deleted' USING ERRCODE = 'restrict_violation';
        END IF;
        IF (NEW.id, NEW.player_id, NEW.currency, NEW.created_at) IS DISTINCT FROM
           (OLD.id, OLD.player_id, OLD.currency, OLD.created_at) THEN
          RAISE EXCEPTION 'wallet % identity columns are immutable', OLD.id USING ERRCODE = 'restrict_violation';
        END IF;
        IF NEW.balance_amount <> OLD.balance_amount AND NEW.version <> OLD.version + 1 THEN
          RAISE EXCEPTION 'wallet % balance changed without version bump', OLD.id USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.balance_amount = OLD.balance_amount AND NEW.version <> OLD.version THEN
          RAISE EXCEPTION 'wallet % version changed without balance change', OLD.id USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$`);
    this.addSql(`
      CREATE TRIGGER wallet_guard_trg BEFORE UPDATE OR DELETE ON wallets
      FOR EACH ROW EXECUTE FUNCTION wallet_guard()`);

    // Every balance state of a wallet is backed by a ledger line (checked at COMMIT).
    this.addSql(`
      CREATE FUNCTION wallet_matches_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.version = 1 AND NEW.balance_amount = 0 THEN
          RETURN NULL; -- opened empty: nothing to back
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM wallet_ledger_entries
          WHERE wallet_id = NEW.id AND wallet_version = NEW.version AND balance_after = NEW.balance_amount
        ) THEN
          RAISE EXCEPTION 'wallet % (version %, balance %) has no matching ledger line', NEW.id, NEW.version, NEW.balance_amount
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NULL;
      END $$`);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER wallet_matches_ledger_trg AFTER INSERT OR UPDATE ON wallets
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION wallet_matches_ledger()`);

    // ------------------------------------------------------------------- inbox
    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name   varchar(64)   NOT NULL,
        message_id      varchar(128)  NOT NULL,
        payload_hash    varchar(64)   NOT NULL,
        received_at     timestamptz   NOT NULL,
        processed_at    timestamptz,
        transaction_id  uuid          REFERENCES wager_transactions(id) DEFERRABLE INITIALLY DEFERRED,
        PRIMARY KEY (consumer_name, message_id)
      )`);

    // ------------------------------------------------------------------ outbox
    this.addSql(`
      CREATE TABLE outbox_messages (
        id               uuid          PRIMARY KEY,
        aggregate_id     uuid          NOT NULL,
        event_type       varchar(64)   NOT NULL,
        payload          jsonb         NOT NULL,
        occurred_at      timestamptz   NOT NULL,
        attempts         integer       NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at  timestamptz   NOT NULL,
        locked_until     timestamptz,
        locked_by        varchar(128),
        published_at     timestamptz,
        last_error       varchar(1024)
      )`);
    this.addSql(`
      CREATE INDEX outbox_pending_idx ON outbox_messages (next_attempt_at)
      WHERE published_at IS NULL`);
    this.addSql(`
      CREATE FUNCTION outbox_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (NEW.id, NEW.aggregate_id, NEW.event_type, NEW.payload, NEW.occurred_at) IS DISTINCT FROM
           (OLD.id, OLD.aggregate_id, OLD.event_type, OLD.payload, OLD.occurred_at) THEN
          RAISE EXCEPTION 'outbox message % content is immutable', OLD.id USING ERRCODE = 'restrict_violation';
        END IF;
        IF OLD.published_at IS NOT NULL AND NEW.published_at IS DISTINCT FROM OLD.published_at THEN
          RAISE EXCEPTION 'outbox message % already published', OLD.id USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
      END $$`);
    this.addSql(`
      CREATE TRIGGER outbox_guard_trg BEFORE UPDATE ON outbox_messages
      FOR EACH ROW EXECUTE FUNCTION outbox_guard()`);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS outbox_messages`);
    this.addSql(`DROP TABLE IF EXISTS inbox_messages`);
    this.addSql(`DROP TABLE IF EXISTS wallet_ledger_entries`);
    this.addSql(`DROP TABLE IF EXISTS wager_transactions`);
    this.addSql(`DROP TABLE IF EXISTS wallets`);
    this.addSql(`DROP FUNCTION IF EXISTS outbox_guard()`);
    this.addSql(`DROP FUNCTION IF EXISTS wallet_matches_ledger()`);
    this.addSql(`DROP FUNCTION IF EXISTS wallet_guard()`);
    this.addSql(`DROP FUNCTION IF EXISTS ledger_matches_wallet()`);
    this.addSql(`DROP FUNCTION IF EXISTS ledger_chain_guard()`);
    this.addSql(`DROP FUNCTION IF EXISTS ledger_append_only()`);
    this.addSql(`DROP FUNCTION IF EXISTS wager_tx_guard()`);
  }
}
