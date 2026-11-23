-- Income sorter (BK-pots-03, J-bank-07 #4): a payment from another person into the account is split across the
-- person's own named spaces by percentage, once.
--
-- A sorter is an instruction, never a balance. Each split moves with the own-space bankTransfer recipe keyed
-- `sorter:<sorter>:<credit ledger tx>` and the leg's position, so a credit moves once whichever path drives it.
-- The credit itself is the posted row in bank.personal_transfers, the durable record that a sweep can re-read.

CREATE TABLE IF NOT EXISTS "bank"."income_sorters" (
  "id" uuid PRIMARY KEY,
  "user_id" text NOT NULL,
  "asset_id" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "cancelled_at" timestamptz,
  CONSTRAINT "income_sorters_status_ck" CHECK ("status" IN ('active', 'cancelled')),
  CONSTRAINT "income_sorters_cancelled_ck" CHECK (("status" = 'cancelled') = ("cancelled_at" IS NOT NULL))
);

-- One live sorter per account and asset: a credit has one answer to "where does it go".
CREATE UNIQUE INDEX IF NOT EXISTS "income_sorters_one_active_uq"
  ON "bank"."income_sorters" ("user_id", "asset_id")
  WHERE "status" = 'active';

CREATE TABLE IF NOT EXISTS "bank"."income_sorter_legs" (
  "sorter_id" uuid NOT NULL REFERENCES "bank"."income_sorters" ("id"),
  "position" smallint NOT NULL,
  "space_id" uuid NOT NULL REFERENCES "bank"."spaces" ("id"),
  -- Share of each credit in basis points; the legs of one sorter total at most 10000, checked when it is made.
  "share_bp" integer NOT NULL,
  PRIMARY KEY ("sorter_id", "position"),
  CONSTRAINT "income_sorter_legs_space_uq" UNIQUE ("sorter_id", "space_id"),
  CONSTRAINT "income_sorter_legs_position_ck" CHECK ("position" BETWEEN 0 AND 9),
  CONSTRAINT "income_sorter_legs_share_ck" CHECK ("share_bp" BETWEEN 1 AND 10000)
);

-- One run per credit that reached a live sorter, ever: split into legs once, or skipped with its reason (under the
-- bank's smallest sorted payment, or no terms stood) and never weighed again.
CREATE TABLE IF NOT EXISTS "bank"."income_sorter_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "sorter_id" uuid NOT NULL REFERENCES "bank"."income_sorters" ("id"),
  "credit_transfer_id" text NOT NULL REFERENCES "bank"."personal_transfers" ("transfer_id"),
  "credit_tx_id" text NOT NULL,
  "credit_amount" numeric(38, 18) NOT NULL,
  "credit_posted_at" timestamptz NOT NULL,
  "skipped_reason" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  -- When the sweep last drove this run's pending splits, so the least recently tried go first.
  "driven_at" timestamptz,
  CONSTRAINT "income_sorter_runs_credit_uq" UNIQUE ("credit_transfer_id"),
  CONSTRAINT "income_sorter_runs_amount_ck" CHECK ("credit_amount" > 0),
  CONSTRAINT "income_sorter_runs_skip_ck" CHECK ("skipped_reason" IS NULL OR "skipped_reason" IN ('below_minimum', 'terms_unset'))
);

CREATE INDEX IF NOT EXISTS "income_sorter_runs_sorter_idx"
  ON "bank"."income_sorter_runs" ("sorter_id", "created_at" DESC);

-- Each leg's share of one credit, fixed when the run is made, and what became of it.
CREATE TABLE IF NOT EXISTS "bank"."income_sorter_run_legs" (
  "run_id" uuid NOT NULL REFERENCES "bank"."income_sorter_runs" ("id"),
  "position" smallint NOT NULL,
  "space_id" uuid NOT NULL REFERENCES "bank"."spaces" ("id"),
  "amount" numeric(38, 18) NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "ledger_tx_id" text,
  "rejection_code" text,
  "settled_at" timestamptz,
  PRIMARY KEY ("run_id", "position"),
  CONSTRAINT "income_sorter_run_legs_amount_ck" CHECK ("amount" > 0),
  CONSTRAINT "income_sorter_run_legs_status_ck" CHECK ("status" IN ('pending', 'settled', 'rejected')),
  CONSTRAINT "income_sorter_run_legs_settled_ck" CHECK (("status" = 'settled') = ("ledger_tx_id" IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS "income_sorter_run_legs_pending_idx"
  ON "bank"."income_sorter_run_legs" ("run_id")
  WHERE "status" = 'pending';

-- The sweep reads credits per recipient and asset in the order they were posted.
CREATE INDEX IF NOT EXISTS "personal_transfers_to_posted_idx"
  ON "bank"."personal_transfers" ("to_user_id", "asset_id", "posted_at")
  WHERE "status" = 'posted';
