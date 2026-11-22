-- svc-bank · initial schema (§8.1 — multi-currency accounts over the ledger)
-- Reversal: 0000_bank_init.down.sql
--
-- The "bank" schema itself is created by the database bootstrap
-- (tooling/infra/postgres-init/01-service-schemas.sql), which also grants it to
-- the svc_bank role. Migrations run as that role and deliberately hold no
-- database-level CREATE privilege — so a migration physically cannot reach
-- outside its own schema (§2).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THERE IS NO BALANCE COLUMN IN THIS FILE.
--
-- §8.1: "no new balance system — views + rails". Doctrine §0.6: "No module
-- holds its own balance." Every numeric column below is one of:
--   · a POLICY LIMIT   (earn_pools.min_deposit, earn_pools.apr_bps)
--   · a GOAL           (spaces.goal_target — what the user wants, not what they have)
--   · an INSTRUCTION   (scheduled_transfers.amount)
--   · a RECORD of one completed event, written once
--                      (transfer_executions.amount, earn_positions.principal,
--                       interest_accruals.paid_amount)
--
-- None of them accumulates. "How much is in this space" is
-- `ledger.balance(...)`, always, and the test suite introspects
-- information_schema.columns to fail the build if that ever stops being true.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Every statement is idempotent: this file is re-runnable, and CHECK
-- constraints are re-asserted with DROP ... IF EXISTS first so tightening one
-- later is an edit here rather than a new migration.

DO $$ BEGIN
  CREATE TYPE "bank"."space_kind" AS ENUM ('primary', 'named');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "bank"."transfer_cadence" AS ENUM ('daily', 'weekly', 'monthly');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "bank"."schedule_status" AS ENUM ('active', 'paused', 'cancelled', 'completed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "bank"."execution_status" AS ENUM ('pending', 'settled', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "bank"."pool_kind" AS ENUM ('flexible', 'fixed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "bank"."pool_status" AS ENUM ('open', 'closed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "bank"."position_status" AS ENUM ('pending', 'active', 'closed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── spaces ───────────────────────────────────────────────────────────────────
-- A name and a policy over a ledger account. Holds no value, by construction.

CREATE TABLE IF NOT EXISTS "bank"."spaces" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"       text NOT NULL,
  "asset_id"      text NOT NULL,
  "kind"          "bank"."space_kind" NOT NULL DEFAULT 'named',
  "name"          text NOT NULL,
  -- A savings TARGET the user set. Never written by a money path.
  "goal_target"   numeric(38, 18),
  "locked_until"  timestamptz,
  "archived_at"   timestamptz,
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  "updated_at"    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "spaces_user_asset_idx" ON "bank"."spaces" ("user_id", "asset_id");
CREATE UNIQUE INDEX IF NOT EXISTS "spaces_user_asset_name_idx" ON "bank"."spaces" ("user_id", "asset_id", "name");

-- EXACTLY ONE PRIMARY SPACE PER USER PER ASSET. The primary space maps to the
-- user's `userAvailable` ledger account; two of them would be two labels
-- claiming the same balance, and a UI summing spaces would double-count the
-- user's own money back to them.
CREATE UNIQUE INDEX IF NOT EXISTS "spaces_one_primary_idx"
  ON "bank"."spaces" ("user_id", "asset_id") WHERE "kind" = 'primary';

-- A negative or zero goal is not a goal; it renders as a progress bar divisor.
ALTER TABLE "bank"."spaces" DROP CONSTRAINT IF EXISTS "spaces_goal_positive_ck";
ALTER TABLE "bank"."spaces" ADD CONSTRAINT "spaces_goal_positive_ck"
  CHECK ("goal_target" IS NULL OR "goal_target" > 0);

-- An empty label makes a space unaddressable in the UI and unresolvable in a
-- support conversation.
ALTER TABLE "bank"."spaces" DROP CONSTRAINT IF EXISTS "spaces_name_present_ck";
ALTER TABLE "bank"."spaces" ADD CONSTRAINT "spaces_name_present_ck"
  CHECK (length(btrim("name")) > 0);

-- ── scheduled_transfers ──────────────────────────────────────────────────────
-- The instruction. Immutable amount; editing means cancel + re-create.

CREATE TABLE IF NOT EXISTS "bank"."scheduled_transfers" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"       text NOT NULL,
  "asset_id"      text NOT NULL,
  "from_space_id" uuid NOT NULL REFERENCES "bank"."spaces"("id"),
  "to_space_id"   uuid NOT NULL REFERENCES "bank"."spaces"("id"),
  "amount"        numeric(38, 18) NOT NULL,
  "cadence"       "bank"."transfer_cadence" NOT NULL,
  "starts_at"     timestamptz NOT NULL,
  "ends_at"       timestamptz,
  "next_run_at"   timestamptz NOT NULL,
  "status"        "bank"."schedule_status" NOT NULL DEFAULT 'active',
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  "updated_at"    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "scheduled_transfers_due_idx"
  ON "bank"."scheduled_transfers" ("status", "next_run_at");
CREATE INDEX IF NOT EXISTS "scheduled_transfers_user_idx" ON "bank"."scheduled_transfers" ("user_id");

-- A zero or negative standing order is either a no-op the ledger will reject on
-- every firing, or — at negative — an instruction to pull money the other way
-- that nobody authorised.
ALTER TABLE "bank"."scheduled_transfers" DROP CONSTRAINT IF EXISTS "scheduled_transfers_amount_positive_ck";
ALTER TABLE "bank"."scheduled_transfers" ADD CONSTRAINT "scheduled_transfers_amount_positive_ck"
  CHECK ("amount" > 0);

-- A transfer to itself moves nothing and would be rejected by the ledger on
-- every occurrence, forever, with no way for the user to see why.
ALTER TABLE "bank"."scheduled_transfers" DROP CONSTRAINT IF EXISTS "scheduled_transfers_distinct_spaces_ck";
ALTER TABLE "bank"."scheduled_transfers" ADD CONSTRAINT "scheduled_transfers_distinct_spaces_ck"
  CHECK ("from_space_id" <> "to_space_id");

-- A window that ends before it starts fires occurrence 0 and then never again,
-- silently — a standing order the user believes is running and is not.
ALTER TABLE "bank"."scheduled_transfers" DROP CONSTRAINT IF EXISTS "scheduled_transfers_window_ordered_ck";
ALTER TABLE "bank"."scheduled_transfers" ADD CONSTRAINT "scheduled_transfers_window_ordered_ck"
  CHECK ("ends_at" IS NULL OR "ends_at" > "starts_at");

-- ── transfer_executions ──────────────────────────────────────────────────────
-- One row per firing. THE reason a double-run transfers once.

CREATE TABLE IF NOT EXISTS "bank"."transfer_executions" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "schedule_id"    uuid NOT NULL REFERENCES "bank"."scheduled_transfers"("id"),
  "occurrence"     integer NOT NULL,
  "amount"         numeric(38, 18) NOT NULL,
  "status"         "bank"."execution_status" NOT NULL DEFAULT 'pending',
  "ledger_tx_id"   text,
  "rejection_code" text,
  "attempted_at"   timestamptz NOT NULL DEFAULT now(),
  "settled_at"     timestamptz
);

-- THE DOUBLE-FIRE GUARD. A scheduler WILL fire twice — a retry, a second
-- worker, a clock stepping backwards over a DST boundary. The job claims the
-- occurrence by inserting this row BEFORE it posts to the ledger; the second
-- run's insert conflicts and it does nothing. The ledger's own idempotency key
-- (`bank.transfer:<scheduleId>:<occurrence>`) is the backstop if this check is
-- ever bypassed, and the two agree by construction because both are derived
-- from the same (schedule, occurrence) pair.
CREATE UNIQUE INDEX IF NOT EXISTS "transfer_executions_occurrence_idx"
  ON "bank"."transfer_executions" ("schedule_id", "occurrence");
CREATE INDEX IF NOT EXISTS "transfer_executions_status_idx" ON "bank"."transfer_executions" ("status");

-- Occurrences are a dense forward sequence from `starts_at`; a negative index
-- means the period arithmetic ran backwards and would mint a key that collides
-- with a firing that already happened.
ALTER TABLE "bank"."transfer_executions" DROP CONSTRAINT IF EXISTS "transfer_executions_occurrence_non_negative_ck";
ALTER TABLE "bank"."transfer_executions" ADD CONSTRAINT "transfer_executions_occurrence_non_negative_ck"
  CHECK ("occurrence" >= 0);

ALTER TABLE "bank"."transfer_executions" DROP CONSTRAINT IF EXISTS "transfer_executions_amount_positive_ck";
ALTER TABLE "bank"."transfer_executions" ADD CONSTRAINT "transfer_executions_amount_positive_ck"
  CHECK ("amount" > 0);

-- A settled execution with no ledger transaction id is a claim that money moved
-- with nothing in the book to point at. That is the exact shape of a phantom
-- transfer, and it must not be representable.
ALTER TABLE "bank"."transfer_executions" DROP CONSTRAINT IF EXISTS "transfer_executions_settled_has_tx_ck";
ALTER TABLE "bank"."transfer_executions" ADD CONSTRAINT "transfer_executions_settled_has_tx_ck"
  CHECK ("status" <> 'settled' OR ("ledger_tx_id" IS NOT NULL AND "settled_at" IS NOT NULL));

-- A rejection with no code is unactionable for the user and unqueryable for the
-- operator: "your standing order did not run" without "because".
ALTER TABLE "bank"."transfer_executions" DROP CONSTRAINT IF EXISTS "transfer_executions_rejected_has_code_ck";
ALTER TABLE "bank"."transfer_executions" ADD CONSTRAINT "transfer_executions_rejected_has_code_ck"
  CHECK ("status" <> 'rejected' OR "rejection_code" IS NOT NULL);

-- ── earn_pools ───────────────────────────────────────────────────────────────
-- Product terms. Note the absence of any "total deposited" column: a pool's
-- size is the sum of the ledger stake accounts behind its open positions.

CREATE TABLE IF NOT EXISTS "bank"."earn_pools" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "asset_id"    text NOT NULL,
  "kind"        "bank"."pool_kind" NOT NULL,
  "name"        text NOT NULL,
  "apr_bps"     numeric(8, 0) NOT NULL,
  "term_days"   integer,
  "min_deposit" numeric(38, 18) NOT NULL DEFAULT 0,
  "status"      "bank"."pool_status" NOT NULL DEFAULT 'open',
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "updated_at"  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "earn_pools_asset_status_idx" ON "bank"."earn_pools" ("asset_id", "status");

-- A negative APR pays negative interest, which the accrual job would post as a
-- debit against the user — a fee dressed as yield. An APR above 100x is almost
-- always a bps/percent unit mix-up, and it drains the pool reserve in a day.
ALTER TABLE "bank"."earn_pools" DROP CONSTRAINT IF EXISTS "earn_pools_apr_sane_ck";
ALTER TABLE "bank"."earn_pools" ADD CONSTRAINT "earn_pools_apr_sane_ck"
  CHECK ("apr_bps" >= 0 AND "apr_bps" <= 1000000);

ALTER TABLE "bank"."earn_pools" DROP CONSTRAINT IF EXISTS "earn_pools_min_deposit_non_negative_ck";
ALTER TABLE "bank"."earn_pools" ADD CONSTRAINT "earn_pools_min_deposit_non_negative_ck"
  CHECK ("min_deposit" >= 0);

-- The term is the only difference between the two pool kinds. A fixed pool with
-- no term never matures — the user's funds are locked with no release date —
-- and a flexible pool with one implies a lock this service does not enforce.
ALTER TABLE "bank"."earn_pools" DROP CONSTRAINT IF EXISTS "earn_pools_term_matches_kind_ck";
ALTER TABLE "bank"."earn_pools" ADD CONSTRAINT "earn_pools_term_matches_kind_ck"
  CHECK (("kind" = 'fixed' AND "term_days" IS NOT NULL AND "term_days" > 0)
      OR ("kind" = 'flexible' AND "term_days" IS NULL));

-- ── earn_positions ───────────────────────────────────────────────────────────
-- The terms of one deposit. Principal recorded once; value lives in the ledger.

CREATE TABLE IF NOT EXISTS "bank"."earn_positions" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "pool_id"    uuid NOT NULL REFERENCES "bank"."earn_pools"("id"),
  "user_id"    text NOT NULL,
  "asset_id"   text NOT NULL,
  "principal"  numeric(38, 18) NOT NULL,
  "opened_at"  timestamptz NOT NULL DEFAULT now(),
  "matures_at" timestamptz,
  "status"     "bank"."position_status" NOT NULL DEFAULT 'active',
  "closed_at"  timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "earn_positions_pool_status_idx" ON "bank"."earn_positions" ("pool_id", "status");
CREATE INDEX IF NOT EXISTS "earn_positions_user_status_idx" ON "bank"."earn_positions" ("user_id", "status");

-- A zero or negative principal still earns a share of the accrual and, at
-- negative, drags the pool's interest base below the sum of the honest
-- positions — paying everyone else out of a reserve that never covered it.
ALTER TABLE "bank"."earn_positions" DROP CONSTRAINT IF EXISTS "earn_positions_principal_positive_ck";
ALTER TABLE "bank"."earn_positions" ADD CONSTRAINT "earn_positions_principal_positive_ck"
  CHECK ("principal" > 0);

-- A maturity at or before the open is a fixed-term lock that never existed —
-- the user gets the fixed rate with flexible liquidity.
ALTER TABLE "bank"."earn_positions" DROP CONSTRAINT IF EXISTS "earn_positions_maturity_after_open_ck";
ALTER TABLE "bank"."earn_positions" ADD CONSTRAINT "earn_positions_maturity_after_open_ck"
  CHECK ("matures_at" IS NULL OR "matures_at" > "opened_at");

-- ── interest_accruals ────────────────────────────────────────────────────────
-- One row per pool per day. The daily double-fire guard.

CREATE TABLE IF NOT EXISTS "bank"."interest_accruals" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "pool_id"      uuid NOT NULL REFERENCES "bank"."earn_pools"("id"),
  "accrual_date" date NOT NULL,
  -- Snapshotted so a later APR change cannot retroactively rewrite what was paid.
  "rate_bps"     numeric(8, 0) NOT NULL,
  "paid_amount"  numeric(38, 18) NOT NULL,
  "recipients"   integer NOT NULL DEFAULT 0,
  "ledger_tx_id" text,
  "created_at"   timestamptz NOT NULL DEFAULT now()
);

-- ONE ACCRUAL PER POOL PER DAY, FOREVER. A daily cron that fires twice — or a
-- catch-up run over a backlog that overlaps the live schedule — would otherwise
-- pay a second day of interest out of a reserve funded for one.
CREATE UNIQUE INDEX IF NOT EXISTS "interest_accruals_pool_date_idx"
  ON "bank"."interest_accruals" ("pool_id", "accrual_date");
CREATE INDEX IF NOT EXISTS "interest_accruals_date_idx" ON "bank"."interest_accruals" ("accrual_date");

-- Interest is never negative: a "negative accrual" is a debit from users'
-- available balances that no user authorised.
ALTER TABLE "bank"."interest_accruals" DROP CONSTRAINT IF EXISTS "interest_accruals_paid_non_negative_ck";
ALTER TABLE "bank"."interest_accruals" ADD CONSTRAINT "interest_accruals_paid_non_negative_ck"
  CHECK ("paid_amount" >= 0);

ALTER TABLE "bank"."interest_accruals" DROP CONSTRAINT IF EXISTS "interest_accruals_recipients_non_negative_ck";
ALTER TABLE "bank"."interest_accruals" ADD CONSTRAINT "interest_accruals_recipients_non_negative_ck"
  CHECK ("recipients" >= 0);

-- Money paid with nobody to pay it to, or recipients paid nothing, both mean
-- the accrual computation and the ledger post disagreed about what happened.
ALTER TABLE "bank"."interest_accruals" DROP CONSTRAINT IF EXISTS "interest_accruals_consistent_ck";
ALTER TABLE "bank"."interest_accruals" ADD CONSTRAINT "interest_accruals_consistent_ck"
  CHECK (("paid_amount" = 0 AND "recipients" = 0 AND "ledger_tx_id" IS NULL)
      OR ("paid_amount" > 0 AND "recipients" > 0));
