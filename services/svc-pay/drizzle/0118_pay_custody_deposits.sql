-- Customer crypto deposit records (W-deposit-05, wallet-deposit-011/012/016/017). NO BALANCE LIVES HERE: a row is the evidence of
-- one transfer to one issued customer address, and the balance moves only by the ledger `deposit` post keyed
-- `deposit:crypto-native:<network>:<tx_hash>:<output_index>`. `credited` rows carry the ledger transaction id of that post.
-- One row per (asset, network, tx_hash, output_index); a repeat delivery finds the row. `held_for_screening` and `reversed` are
-- written by W-deposit-06 (holds, reorg); they are allowed here so no later migration widens the CHECK on a money table.
CREATE TABLE IF NOT EXISTS "pay"."custody_deposits" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" text NOT NULL,
  "asset_id" text NOT NULL,
  "network_id" text NOT NULL,
  "address" text NOT NULL,
  "tx_hash" text NOT NULL,
  "output_index" integer NOT NULL,
  "amount" text NOT NULL,
  "confirmations" integer NOT NULL DEFAULT 0,
  "confirmations_required" integer,
  "minimum_deposit" text,
  "status" text NOT NULL DEFAULT 'detected',
  "reason" text,
  "ledger_tx_id" text,
  "detected_at" timestamptz NOT NULL DEFAULT now(),
  "credit_started_at" timestamptz,
  "credited_at" timestamptz,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "custody_deposits_ids_ck" CHECK ("asset_id" ~ '^[A-Za-z0-9]{1,16}$' AND "network_id" ~ '^[A-Za-z0-9_-]{1,32}$'),
  CONSTRAINT "custody_deposits_amount_ck" CHECK ("amount" ~ '^(0|[1-9][0-9]{0,29})(\.[0-9]{1,18})?$' AND "amount"::numeric > 0),
  CONSTRAINT "custody_deposits_index_ck" CHECK ("output_index" >= 0 AND "confirmations" >= 0),
  CONSTRAINT "custody_deposits_required_ck" CHECK ("confirmations_required" IS NULL OR "confirmations_required" >= 1),
  CONSTRAINT "custody_deposits_status_ck" CHECK ("status" IN
    ('detected', 'confirming', 'credited', 'below_minimum', 'held_for_screening', 'rejected', 'reversed', 'needs_review')),
  CONSTRAINT "custody_deposits_reason_ck" CHECK ("reason" IS NULL OR "reason" IN
    ('below_minimum', 'amount_mismatch', 'unknown_asset', 'minimum_unset', 'confirmations_unset')),
  CONSTRAINT "custody_deposits_credited_ck" CHECK (("status" = 'credited') = ("credited_at" IS NOT NULL AND "ledger_tx_id" IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS "custody_deposits_chain_uq"
  ON "pay"."custody_deposits" ("asset_id", "network_id", "tx_hash", "output_index");
CREATE INDEX IF NOT EXISTS "custody_deposits_user_idx" ON "pay"."custody_deposits" ("user_id", "detected_at" DESC);
CREATE INDEX IF NOT EXISTS "custody_deposits_open_idx" ON "pay"."custody_deposits" ("status") WHERE "status" IN ('detected', 'confirming');
