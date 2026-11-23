-- svc-ledger · initial schema (§4.2 THE BALANCE)
-- Reversal: 0000_ledger_init.down.sql
--
-- The "ledger" schema itself is created by the database bootstrap
-- (tooling/infra/postgres-init/01-service-schemas.sql), which also grants it to
-- the svc_ledger role. Migrations run as that role and deliberately hold no
-- database-level CREATE privilege — so a migration physically cannot reach
-- outside its own schema (§2).

DO $$ BEGIN
  CREATE TYPE "ledger"."owner_type" AS ENUM ('user', 'subaccount', 'module', 'house', 'treasury');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "ledger"."account_kind" AS ENUM ('available', 'hold', 'escrow', 'stake', 'collateral');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "ledger"."asset_kind" AS ENUM ('crypto', 'fiat', 'native');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "ledger"."direction" AS ENUM ('debit', 'credit');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "ledger"."assets" (
  "id"         text PRIMARY KEY,
  "kind"       "ledger"."asset_kind" NOT NULL,
  "decimals"   integer NOT NULL DEFAULT 18,
  "active"     boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "ledger"."accounts" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "owner_type" "ledger"."owner_type" NOT NULL,
  "owner_id"   text NOT NULL,
  "asset_id"   text NOT NULL,
  "kind"       "ledger"."account_kind" NOT NULL,
  -- Denormalised cache of the entry sum. Guarded by the reconciliation job.
  "balance"    numeric(38, 18) NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "accounts_identity_idx"
  ON "ledger"."accounts" ("owner_type", "owner_id", "asset_id", "kind");
CREATE INDEX IF NOT EXISTS "accounts_owner_idx"
  ON "ledger"."accounts" ("owner_type", "owner_id");

-- INVARIANT, in the database itself: only treasury accounts may run negative.
-- The service checks this too; belt and braces, because a bug in the service
-- must not be able to create money.
ALTER TABLE "ledger"."accounts" DROP CONSTRAINT IF EXISTS "accounts_non_negative_ck";
ALTER TABLE "ledger"."accounts" ADD CONSTRAINT "accounts_non_negative_ck"
  CHECK ("owner_type" = 'treasury' OR "balance" >= 0);

CREATE TABLE IF NOT EXISTS "ledger"."ledger_tx" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "seq"             bigserial NOT NULL,
  "idempotency_key" text NOT NULL,
  "module"          text NOT NULL,
  "reason"          text NOT NULL,
  "meta"            jsonb NOT NULL DEFAULT '{}'::jsonb,
  "posted_at"       timestamptz NOT NULL DEFAULT now(),
  "hash"            text NOT NULL,
  "previous_hash"   text
);

CREATE UNIQUE INDEX IF NOT EXISTS "ledger_tx_idempotency_idx" ON "ledger"."ledger_tx" ("idempotency_key");
CREATE INDEX IF NOT EXISTS "ledger_tx_seq_idx" ON "ledger"."ledger_tx" ("seq");
CREATE INDEX IF NOT EXISTS "ledger_tx_module_idx" ON "ledger"."ledger_tx" ("module", "posted_at");

CREATE TABLE IF NOT EXISTS "ledger"."ledger_entries" (
  "id"            bigserial PRIMARY KEY,
  "tx_id"         uuid NOT NULL REFERENCES "ledger"."ledger_tx"("id"),
  "account_id"    uuid NOT NULL REFERENCES "ledger"."accounts"("id"),
  "asset_id"      text NOT NULL,
  "direction"     "ledger"."direction" NOT NULL,
  "amount"        numeric(38, 18) NOT NULL,
  "balance_after" numeric(38, 18) NOT NULL
);

-- An entry of zero, or a negative amount, is never a movement. Direction
-- carries the sign; the amount never does.
ALTER TABLE "ledger"."ledger_entries" DROP CONSTRAINT IF EXISTS "ledger_entries_positive_ck";
ALTER TABLE "ledger"."ledger_entries" ADD CONSTRAINT "ledger_entries_positive_ck"
  CHECK ("amount" > 0);

CREATE INDEX IF NOT EXISTS "ledger_entries_tx_idx" ON "ledger"."ledger_entries" ("tx_id");
CREATE INDEX IF NOT EXISTS "ledger_entries_account_idx" ON "ledger"."ledger_entries" ("account_id", "id");

CREATE TABLE IF NOT EXISTS "ledger"."balance_snapshots" (
  "id"                bigserial PRIMARY KEY,
  "account_id"        uuid NOT NULL REFERENCES "ledger"."accounts"("id"),
  "as_of"             timestamptz NOT NULL,
  "balance"           numeric(38, 18) NOT NULL,
  "through_entry_id"  text
);

CREATE INDEX IF NOT EXISTS "balance_snapshots_account_idx"
  ON "ledger"."balance_snapshots" ("account_id", "as_of");

-- Tip of the hash chain. Exactly one row, ever.
CREATE TABLE IF NOT EXISTS "ledger"."chain_tip" (
  "id"         boolean PRIMARY KEY DEFAULT true,
  "hash"       text,
  "seq"        bigint NOT NULL DEFAULT 0,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "chain_tip_singleton_ck" CHECK ("id" = true)
);

INSERT INTO "ledger"."chain_tip" ("id", "hash", "seq")
  VALUES (true, NULL, 0)
  ON CONFLICT ("id") DO NOTHING;

-- Seed assets. Adding one is a data change, never a code change.
INSERT INTO "ledger"."assets" ("id", "kind", "decimals") VALUES
  ('BTC',  'crypto', 8),
  ('ETH',  'crypto', 18),
  ('USDT', 'crypto', 6),
  ('USDC', 'crypto', 6),
  ('IFC',  'native', 18),
  ('USD',  'fiat',   2),
  ('EUR',  'fiat',   2),
  ('GBP',  'fiat',   2)
ON CONFLICT ("id") DO NOTHING;
