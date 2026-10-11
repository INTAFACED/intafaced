-- svc-token · initial schema (§4.3 THE NATIVE ECONOMY — IFC)
-- Reversal: 0000_token_init.down.sql
--
-- The "token" schema itself is created by the database bootstrap
-- (tooling/infra/postgres-init/01-service-schemas.sql), which also grants it to
-- the svc_token role. Migrations run as that role and deliberately hold no
-- database-level CREATE privilege — so a migration physically cannot reach
-- outside its own schema (§2).
--
-- Every statement below is idempotent: this file is re-runnable, and the CHECK
-- constraints are re-asserted with DROP ... IF EXISTS first so tightening one
-- later is an edit here rather than a new migration.

DO $$ BEGIN
  CREATE TYPE "token"."stake_tier" AS ENUM ('flex', 'm3', 'm12');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "token"."stake_status" AS ENUM ('pending', 'active', 'unstaking', 'closed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "token"."proposal_kind" AS ENUM ('listing', 'fee_param', 'curriculum', 'grant');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "token"."proposal_status" AS ENUM ('draft', 'open', 'passed', 'rejected', 'executed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "token"."vote_choice" AS ENUM ('for', 'against', 'abstain');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── token_params ─────────────────────────────────────────────────────────────
-- Every tunable of the IFC economy, in one governable row (§4.3).

CREATE TABLE IF NOT EXISTS "token"."token_params" (
  "id"                    boolean PRIMARY KEY DEFAULT true,
  -- NULL until an owner writes them. A migration must not invent a supply,
  -- an emission amount, a buyback split, or a fee ladder.
  "total_supply"          numeric(38, 18),
  "emission_curve"        jsonb,
  "halving_interval"      integer,
  "fee_discount_schedule" jsonb,
  "buyback_bps"           numeric(8, 0),
  "burn_split_bps"        numeric(8, 0),
  "updated_at"            timestamptz NOT NULL DEFAULT now(),
  -- Exactly one row, ever. A second params row would mean two economies, and
  -- whichever one a given job happened to SELECT would silently win.
  CONSTRAINT "token_params_singleton_ck" CHECK ("id" = true)
);

-- Catches a bad governance payload or a unit mix-up (percent written where bps
-- were meant) turning the buyback into a >100%-of-revenue drain on the treasury.
ALTER TABLE "token"."token_params" DROP CONSTRAINT IF EXISTS "token_params_buyback_bps_ck";
ALTER TABLE "token"."token_params" ADD CONSTRAINT "token_params_buyback_bps_ck"
  CHECK ("buyback_bps" >= 0 AND "buyback_bps" <= 10000);

-- Same class of bug on the other side of the flywheel: a burn split above 100%
-- would burn tokens that were also promised to the rewards engine (§4.3).
ALTER TABLE "token"."token_params" DROP CONSTRAINT IF EXISTS "token_params_burn_split_bps_ck";
ALTER TABLE "token"."token_params" ADD CONSTRAINT "token_params_burn_split_bps_ck"
  CHECK ("burn_split_bps" >= 0 AND "burn_split_bps" <= 10000);

-- A zero or negative cap would make every emission-schedule comparison vacuous
-- and remove the only ceiling on minting. NULL stays NULL: an undecided cap is
-- not zero, and the check does not fill one in.
ALTER TABLE "token"."token_params" DROP CONSTRAINT IF EXISTS "token_params_supply_positive_ck";
ALTER TABLE "token"."token_params" ADD CONSTRAINT "token_params_supply_positive_ck"
  CHECK ("total_supply" > 0);

-- A halving interval of zero divides by zero in the curve; a negative one runs
-- the schedule backwards and inflates rewards forever.
ALTER TABLE "token"."token_params" DROP CONSTRAINT IF EXISTS "token_params_halving_positive_ck";
ALTER TABLE "token"."token_params" ADD CONSTRAINT "token_params_halving_positive_ck"
  CHECK ("halving_interval" > 0);

-- Re-runnable: a table created by an older copy of this file still has NOT NULL
-- and '{}' defaults. Dropping those is what lets a blank stay blank. It does
-- not write a supply, an emission amount, or a fee ladder.
ALTER TABLE "token"."token_params" ALTER COLUMN "total_supply" DROP NOT NULL;
ALTER TABLE "token"."token_params" ALTER COLUMN "emission_curve" DROP NOT NULL;
ALTER TABLE "token"."token_params" ALTER COLUMN "emission_curve" DROP DEFAULT;
ALTER TABLE "token"."token_params" ALTER COLUMN "halving_interval" DROP NOT NULL;
ALTER TABLE "token"."token_params" ALTER COLUMN "fee_discount_schedule" DROP NOT NULL;
ALTER TABLE "token"."token_params" ALTER COLUMN "fee_discount_schedule" DROP DEFAULT;
ALTER TABLE "token"."token_params" ALTER COLUMN "buyback_bps" DROP NOT NULL;
ALTER TABLE "token"."token_params" ALTER COLUMN "burn_split_bps" DROP NOT NULL;

-- ── stakes ───────────────────────────────────────────────────────────────────
-- The terms of each staked position (§4.3). Principal lives in the ledger.

CREATE TABLE IF NOT EXISTS "token"."stakes" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"        text NOT NULL,
  "amount"         numeric(38, 18) NOT NULL,
  "tier"           "token"."stake_tier" NOT NULL,
  -- Snapshotted at open so a later governance change cannot re-price it.
  "multiplier_bps" numeric(8, 0) NOT NULL,
  "started_at"     timestamptz NOT NULL DEFAULT now(),
  "unlocks_at"     timestamptz,
  -- Pending until the ledger post activates the row. An insert that omits
  -- status must not be yield-eligible. CREATE TABLE IF NOT EXISTS will not
  -- change this on a book that already applied 0000; 0005 sets the same default.
  "status"         "token"."stake_status" NOT NULL DEFAULT 'pending',
  "created_at"     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "stakes_user_status_idx" ON "token"."stakes" ("user_id", "status");
CREATE INDEX IF NOT EXISTS "stakes_status_idx" ON "token"."stakes" ("status");
CREATE INDEX IF NOT EXISTS "stakes_unlocks_idx" ON "token"."stakes" ("unlocks_at");

-- A zero or negative stake would still occupy a share of the real-yield pool
-- and, at negative, would drag the pro-rata denominator below the sum of the
-- honest stakes — paying everyone else more than the pool holds.
ALTER TABLE "token"."stakes" DROP CONSTRAINT IF EXISTS "stakes_amount_positive_ck";
ALTER TABLE "token"."stakes" ADD CONSTRAINT "stakes_amount_positive_ck"
  CHECK ("amount" > 0);

-- A negative multiplier inverts a staker's weight in the yield distribution.
ALTER TABLE "token"."stakes" DROP CONSTRAINT IF EXISTS "stakes_multiplier_non_negative_ck";
ALTER TABLE "token"."stakes" ADD CONSTRAINT "stakes_multiplier_non_negative_ck"
  CHECK ("multiplier_bps" >= 0);

-- The lock is the whole difference between flex and m3/m12. A locked stake
-- written without an unlock date earns the lock multiplier while being
-- withdrawable on demand — free yield.
ALTER TABLE "token"."stakes" DROP CONSTRAINT IF EXISTS "stakes_lock_required_ck";
ALTER TABLE "token"."stakes" ADD CONSTRAINT "stakes_lock_required_ck"
  CHECK ("tier" = 'flex' OR "unlocks_at" IS NOT NULL);

-- An unlock date at or before the start is a lock that never existed — the same
-- free-yield bug arrived at via clock skew or a bad duration calculation.
ALTER TABLE "token"."stakes" DROP CONSTRAINT IF EXISTS "stakes_unlock_after_start_ck";
ALTER TABLE "token"."stakes" ADD CONSTRAINT "stakes_unlock_after_start_ck"
  CHECK ("unlocks_at" IS NULL OR "unlocks_at" > "started_at");

-- ── emission_epochs ──────────────────────────────────────────────────────────
-- svc-token is the only minter (§4.3); this table is the mint's ledger.

CREATE TABLE IF NOT EXISTS "token"."emission_epochs" (
  "epoch"            integer PRIMARY KEY,
  "scheduled_amount" numeric(38, 18) NOT NULL,
  "mined_amount"     numeric(38, 18) NOT NULL DEFAULT 0,
  "difficulty"       numeric(38, 18) NOT NULL DEFAULT 1,
  "closed"           boolean NOT NULL DEFAULT false,
  "created_at"       timestamptz NOT NULL DEFAULT now()
);

-- THE MINT CEILING, in the database itself. A double-processed allocation
-- request from svc-mining-pool, or a retry that skips the service-side check,
-- would otherwise mint IFC that the emission curve never authorised. The
-- service checks this too; belt and braces, because a bug in the service must
-- not be able to create supply.
ALTER TABLE "token"."emission_epochs" DROP CONSTRAINT IF EXISTS "emission_epochs_within_schedule_ck";
ALTER TABLE "token"."emission_epochs" ADD CONSTRAINT "emission_epochs_within_schedule_ck"
  CHECK ("mined_amount" >= 0 AND "mined_amount" <= "scheduled_amount");

-- A negative schedule would let the constraint above pass while the epoch owes
-- supply back to nobody.
ALTER TABLE "token"."emission_epochs" DROP CONSTRAINT IF EXISTS "emission_epochs_scheduled_non_negative_ck";
ALTER TABLE "token"."emission_epochs" ADD CONSTRAINT "emission_epochs_scheduled_non_negative_ck"
  CHECK ("scheduled_amount" >= 0);

-- Epochs are a dense, forward sequence; a negative epoch number means the
-- halving index went backwards and the reward doubled instead of halving.
ALTER TABLE "token"."emission_epochs" DROP CONSTRAINT IF EXISTS "emission_epochs_epoch_non_negative_ck";
ALTER TABLE "token"."emission_epochs" ADD CONSTRAINT "emission_epochs_epoch_non_negative_ck"
  CHECK ("epoch" >= 0);

-- Difficulty is a divisor in share weighting; zero or below is undefined.
ALTER TABLE "token"."emission_epochs" DROP CONSTRAINT IF EXISTS "emission_epochs_difficulty_positive_ck";
ALTER TABLE "token"."emission_epochs" ADD CONSTRAINT "emission_epochs_difficulty_positive_ck"
  CHECK ("difficulty" > 0);

-- ── buyback_runs ─────────────────────────────────────────────────────────────
-- The flywheel's audit trail (§4.3): revenue in, burn + rewards out.

CREATE TABLE IF NOT EXISTS "token"."buyback_runs" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "revenue_window_from" timestamptz NOT NULL,
  "revenue_window_to"   timestamptz NOT NULL,
  "revenue_total"       jsonb NOT NULL DEFAULT '{}'::jsonb,
  "tokens_bought"       numeric(38, 18) NOT NULL,
  "tokens_burned"       numeric(38, 18) NOT NULL,
  "tokens_to_rewards"   numeric(38, 18) NOT NULL,
  "executed_at"         timestamptz NOT NULL DEFAULT now(),
  "created_at"          timestamptz NOT NULL DEFAULT now()
);

-- A revenue window is spent exactly once. Without this, a retried or
-- double-scheduled job would buy against the same fees twice — treasury spend
-- with no revenue behind it.
CREATE UNIQUE INDEX IF NOT EXISTS "buyback_runs_window_idx"
  ON "token"."buyback_runs" ("revenue_window_from", "revenue_window_to");
CREATE INDEX IF NOT EXISTS "buyback_runs_executed_idx" ON "token"."buyback_runs" ("executed_at");

-- An inverted or empty window silently aggregates zero revenue, so the run
-- reports success having bought nothing — a failure that looks like a no-op.
ALTER TABLE "token"."buyback_runs" DROP CONSTRAINT IF EXISTS "buyback_runs_window_ordered_ck";
ALTER TABLE "token"."buyback_runs" ADD CONSTRAINT "buyback_runs_window_ordered_ck"
  CHECK ("revenue_window_to" > "revenue_window_from");

-- CONSERVATION. The split can never distribute more than was actually bought;
-- a rounding bug in the burn/rewards division would otherwise promise the
-- rewards engine tokens that do not exist.
ALTER TABLE "token"."buyback_runs" DROP CONSTRAINT IF EXISTS "buyback_runs_split_conserved_ck";
ALTER TABLE "token"."buyback_runs" ADD CONSTRAINT "buyback_runs_split_conserved_ck"
  CHECK (
    "tokens_bought" >= 0
    AND "tokens_burned" >= 0
    AND "tokens_to_rewards" >= 0
    AND "tokens_burned" + "tokens_to_rewards" <= "tokens_bought"
  );

-- ── proposals ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "token"."proposals" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "kind"       "token"."proposal_kind" NOT NULL,
  "body"       jsonb NOT NULL DEFAULT '{}'::jsonb,
  "status"     "token"."proposal_status" NOT NULL DEFAULT 'draft',
  "opens_at"   timestamptz NOT NULL,
  "closes_at"  timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "proposals_status_closes_idx" ON "token"."proposals" ("status", "closes_at");
CREATE INDEX IF NOT EXISTS "proposals_kind_idx" ON "token"."proposals" ("kind");

-- A window that closes before it opens can never accept a vote, so the tally
-- would pass it unanimously on zero ballots.
ALTER TABLE "token"."proposals" DROP CONSTRAINT IF EXISTS "proposals_window_ordered_ck";
ALTER TABLE "token"."proposals" ADD CONSTRAINT "proposals_window_ordered_ck"
  CHECK ("closes_at" > "opens_at");

-- ── governance_votes ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "token"."governance_votes" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "proposal_id" uuid NOT NULL REFERENCES "token"."proposals"("id"),
  "user_id"     text NOT NULL,
  -- Snapshotted at cast time, not read at tally time.
  "weight"      numeric(38, 18) NOT NULL,
  "choice"      "token"."vote_choice" NOT NULL,
  "cast_at"     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "governance_votes_proposal_idx" ON "token"."governance_votes" ("proposal_id");

-- ONE BALLOT PER MEMBER PER PROPOSAL. Without it, a client retry or a
-- double-submitted form counts twice, and a determined voter can simply POST in
-- a loop to carry any vote (§4.3 governance is IFC-weighted, not click-weighted).
CREATE UNIQUE INDEX IF NOT EXISTS "governance_votes_one_per_user_idx"
  ON "token"."governance_votes" ("proposal_id", "user_id");

-- A negative weight is a vote that subtracts from its own side — it would let a
-- holder swing a tally toward the option they did not choose.
ALTER TABLE "token"."governance_votes" DROP CONSTRAINT IF EXISTS "governance_votes_weight_non_negative_ck";
ALTER TABLE "token"."governance_votes" ADD CONSTRAINT "governance_votes_weight_non_negative_ck"
  CHECK ("weight" >= 0);

-- ── Singleton ────────────────────────────────────────────────────────────────
-- The row exists so an owner can write a decision later. Supply, the emission
-- amount, buyback, and the fee schedule stay null. ON CONFLICT DO NOTHING only
-- keeps a row that is already there; it does not fill those columns, so an
-- undecided number cannot freeze.

INSERT INTO "token"."token_params" ("id")
VALUES (true)
ON CONFLICT ("id") DO NOTHING;
