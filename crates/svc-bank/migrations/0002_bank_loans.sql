-- svc-bank — COLLATERALISED LOANS (§8.1)
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THERE IS NO `outstanding` COLUMN, AND THAT IS THE DESIGN
-- ─────────────────────────────────────────────────────────────────────────────
--
-- A loan's outstanding debt is the number this whole module turns on: it decides
-- the LTV, and the LTV decides whether someone's collateral is sold. The obvious
-- schema gives `loans` an `outstanding_principal numeric(38,18)` and has the
-- accrual job add to it every night.
--
-- `bank-service.test.ts` fails the build on exactly that column, by name, and it
-- is right to. A mutable money column updated by a nightly job is a running total
-- and a second source of truth, and the failure mode is specific: an accrual that
-- half-ran, a retry that double-applied, or a repayment that raced it leaves a
-- figure nothing can contradict. Every LTV afterwards is computed from it. There
-- is no reconciliation available because the column IS the record.
--
-- So the debt is EVENT-SOURCED. Every table below is write-once — the third of
-- the three legitimate kinds the schema header names, "a record of something that
-- already happened" — and outstanding debt is derived:
--
--     outstanding = loans.principal
--                 + Σ loan_interest_accruals.interest_amount
--                 − Σ loan_repayments.principal_amount
--                 − Σ loan_repayments.interest_amount
--                 − Σ loan_liquidations.principal_repaid
--                 − Σ loan_liquidations.interest_repaid
--
-- computed in `loan-service.ts`, in bigint, on every read. A crashed accrual
-- leaves a row or it does not; there is no third state and no figure to repair.
--
-- Not a VIEW either, deliberately: a view's columns appear in
-- `information_schema.columns`, so a view exposing this sum would either trip the
-- guard or have to be named to dodge it. Dodging a guard that is telling the truth
-- is worse than the column would have been.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- AND NO BALANCE, ANYWHERE
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Collateral lives in `loan_collateral_events`, as a log — not a figure. How much
-- collateral a loan holds RIGHT NOW is `ledger.balance(user/<id>/<asset>/
-- collateral/loan:<loanId>)`, and the log exists so a job is idempotent and a
-- human can read the history. Doctrine §0.6 all the way down.

-- The states, in the order a loan moves through them:
--
--   pending      Collateral is LOCKED; principal has NOT been released. A crash
--                between the two lands here, and nothing is stranded — the
--                collateral is in the borrower's own purposed ledger account and
--                the reserve has not moved.
--   active       Drawn and healthy.
--   margin_call  LTV crossed the margin-call threshold and the grace clock is
--                running. A loan CANNOT reach `liquidating` without passing
--                through here, except on the insolvency branch — see
--                loan_products.insolvency_ltv_bps.
--   liquidating  A tranche is in flight.
--   repaid       Debt cleared by the borrower; collateral returned.
--   liquidated   Debt cleared by seizure; any surplus collateral returned.
DO $$ BEGIN
  CREATE TYPE "bank"."loan_status" AS ENUM ('pending', 'active', 'margin_call', 'liquidating', 'repaid', 'liquidated');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "bank"."collateral_direction" AS ENUM ('lock', 'release');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "bank"."loan_event_status" AS ENUM ('pending', 'settled', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- POLICY. Every money column here is a LIMIT, and no money path writes any of
-- them.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "bank"."loan_products" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" text NOT NULL,
  "debt_asset_id" text NOT NULL,
  "collateral_asset_id" text NOT NULL,
  -- The asset LTV is measured in. Both marks are taken against it.
  "quote_asset_id" text NOT NULL,
  "apr_bps" integer NOT NULL,
  -- The most a borrower may draw. Below margin_call, with room to move.
  "max_ltv_bps" integer NOT NULL,
  "margin_call_ltv_bps" integer NOT NULL,
  "liquidation_ltv_bps" integer NOT NULL,
  -- Grace is waived above this. The one place the margin-call-before-liquidation
  -- ordering is knowingly broken, as a number in policy rather than a branch in
  -- code, so it shows up in a diff. See risk.ts.
  "insolvency_ltv_bps" integer NOT NULL,
  -- Where a liquidation STOPS. Must be below margin_call or a liquidation leaves
  -- the loan still in margin call and fires again on the next mark.
  "target_ltv_bps" integer NOT NULL,
  "penalty_bps" integer NOT NULL,
  -- Ceiling on one rung of the ladder, as a fraction of remaining collateral.
  "max_tranche_bps" integer NOT NULL,
  "grace_seconds" integer NOT NULL,
  -- A POLICY floor on a single draw. A limit, never a holding.
  "min_principal" numeric(38, 18) NOT NULL DEFAULT 0,
  "status" text NOT NULL DEFAULT 'open',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),

  -- The ordering, in the database. A product whose thresholds are incoherent
  -- produces a loan that can be liquidated before it is called, or one that can
  -- never be liquidated at all, and neither is discoverable by reading a row.
  CONSTRAINT "loan_products_ltv_ordered" CHECK (
    "max_ltv_bps" > 0
    AND "target_ltv_bps" < "margin_call_ltv_bps"
    AND "max_ltv_bps" < "margin_call_ltv_bps"
    AND "margin_call_ltv_bps" < "liquidation_ltv_bps"
    AND "liquidation_ltv_bps" <= "insolvency_ltv_bps"
  ),
  CONSTRAINT "loan_products_bps_bounded" CHECK (
    "apr_bps" >= 0
    AND "penalty_bps" >= 0 AND "penalty_bps" <= 10000
    AND "max_tranche_bps" > 0 AND "max_tranche_bps" <= 10000
    AND "grace_seconds" >= 0
  ),
  CONSTRAINT "loan_products_cross_asset" CHECK ("debt_asset_id" <> "collateral_asset_id")
);

CREATE INDEX IF NOT EXISTS "loan_products_assets_idx"
  ON "bank"."loan_products" ("debt_asset_id", "collateral_asset_id", "status");

-- ─────────────────────────────────────────────────────────────────────────────
-- ONE LOAN.
--
-- `principal` is the amount DRAWN at open, recorded once and never revised — the
-- same shape and the same reason as `earn_positions.principal`. Interest does not
-- touch it: the day's charge is a row in loan_interest_accruals, which is what
-- keeps this column from becoming the running total the schema forbids.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "bank"."loans" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "product_id" uuid NOT NULL REFERENCES "bank"."loan_products" ("id"),
  "user_id" text NOT NULL,
  -- Snapshotted from the product at open, so a later product edit cannot rewrite
  -- the terms of a loan somebody already agreed to. The same reason
  -- interest_accruals snapshots rate_bps.
  "debt_asset_id" text NOT NULL,
  "collateral_asset_id" text NOT NULL,
  "quote_asset_id" text NOT NULL,
  "apr_bps" integer NOT NULL,
  "principal" numeric(38, 18) NOT NULL,
  "status" "bank"."loan_status" NOT NULL DEFAULT 'pending',
  -- The ledger transaction that released the principal. NULL means it has not
  -- been drawn, and that is the crash-safe state.
  "draw_ledger_tx_id" text,
  "opened_at" timestamptz NOT NULL DEFAULT now(),
  "drawn_at" timestamptz,
  -- When the CURRENT margin call started. NULL = not in one. The grace clock
  -- reads from here, and `planLiquidation` refuses to liquidate while it is NULL.
  "margin_called_at" timestamptz,
  -- The last mark accepted for this loan, for the deviation breaker in prices.ts.
  -- A price, not a balance: it is what one unit of collateral was worth, never an
  -- amount anybody holds.
  "last_mark_price" numeric(38, 18),
  "last_marked_at" timestamptz,
  "closed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "loans_principal_positive" CHECK ("principal" > 0),
  CONSTRAINT "loans_cross_asset" CHECK ("debt_asset_id" <> "collateral_asset_id")
);

CREATE INDEX IF NOT EXISTS "loans_user_status_idx" ON "bank"."loans" ("user_id", "status");
-- The LTV job's sweep: every loan that can still move.
CREATE INDEX IF NOT EXISTS "loans_open_idx" ON "bank"."loans" ("status") WHERE "status" IN ('active', 'margin_call', 'liquidating');

-- ─────────────────────────────────────────────────────────────────────────────
-- COLLATERAL MOVEMENTS — a log, not a figure.
--
-- `unique(loan_id, sequence)` is the double-fire guard. A borrower topping up
-- collateral to cure a margin call must be able to do it more than once, so the
-- sequence is part of the key rather than the loan alone.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "bank"."loan_collateral_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "loan_id" uuid NOT NULL REFERENCES "bank"."loans" ("id"),
  "sequence" integer NOT NULL,
  "direction" "bank"."collateral_direction" NOT NULL,
  -- A RECORD of one completed movement, written once alongside its ledger tx id.
  "amount" numeric(38, 18) NOT NULL,
  "status" "bank"."loan_event_status" NOT NULL DEFAULT 'pending',
  "ledger_tx_id" text,
  "rejection_code" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "settled_at" timestamptz,

  CONSTRAINT "loan_collateral_amount_positive" CHECK ("amount" > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "loan_collateral_events_seq_idx"
  ON "bank"."loan_collateral_events" ("loan_id", "sequence");
CREATE INDEX IF NOT EXISTS "loan_collateral_events_loan_idx" ON "bank"."loan_collateral_events" ("loan_id", "status");

-- ─────────────────────────────────────────────────────────────────────────────
-- ONE DAY OF INTEREST FOR ONE LOAN — the idempotency guard the whole accrual
-- story rests on.
--
-- `unique(loan_id, accrual_date)` makes "a job that runs twice charges once" a
-- property of the database rather than a hope about timers. Daily compounding
-- that double-applies is not a reporting error, it is a charge the borrower did
-- not incur, and it compounds from then on.
--
-- THERE IS NO `ledger_tx_id`, and its absence is the point. Loan interest
-- CAPITALISES: the day's charge increases the debt and moves no value, because a
-- borrower with an empty available balance cannot be debited nightly and a design
-- that tried would liquidate people for not holding cash they had just borrowed
-- against. Value moves at repayment or liquidation, and `loan_repayments` /
-- `loan_liquidations` carry the tx ids for those.
--
-- `principal_basis` is the debt the day was computed against — a snapshot, so the
-- arithmetic of any past day can be re-derived from its own row without replaying
-- the whole loan.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "bank"."loan_interest_accruals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "loan_id" uuid NOT NULL REFERENCES "bank"."loans" ("id"),
  "accrual_date" date NOT NULL,
  -- Snapshotted so a later APR change cannot rewrite history.
  "rate_bps" integer NOT NULL,
  "principal_basis" numeric(38, 18) NOT NULL,
  "interest_amount" numeric(38, 18) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "loan_interest_non_negative" CHECK ("interest_amount" >= 0 AND "principal_basis" >= 0)
);

-- ONE ACCRUAL PER LOAN PER DAY, forever.
CREATE UNIQUE INDEX IF NOT EXISTS "loan_interest_accruals_day_idx"
  ON "bank"."loan_interest_accruals" ("loan_id", "accrual_date");
CREATE INDEX IF NOT EXISTS "loan_interest_accruals_date_idx" ON "bank"."loan_interest_accruals" ("accrual_date");

-- ─────────────────────────────────────────────────────────────────────────────
-- REPAYMENTS. Partial repayment is normal, so the key is (loan, sequence).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "bank"."loan_repayments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "loan_id" uuid NOT NULL REFERENCES "bank"."loans" ("id"),
  "sequence" integer NOT NULL,
  -- RECORDS of one completed repayment, written once. Interest is settled before
  -- principal — see the waterfall in risk.ts.
  "interest_amount" numeric(38, 18) NOT NULL,
  "principal_amount" numeric(38, 18) NOT NULL,
  "status" "bank"."loan_event_status" NOT NULL DEFAULT 'pending',
  "ledger_tx_id" text,
  "rejection_code" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "settled_at" timestamptz,

  CONSTRAINT "loan_repayment_non_negative" CHECK ("interest_amount" >= 0 AND "principal_amount" >= 0),
  CONSTRAINT "loan_repayment_not_empty" CHECK ("interest_amount" + "principal_amount" > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "loan_repayments_seq_idx" ON "bank"."loan_repayments" ("loan_id", "sequence");
CREATE INDEX IF NOT EXISTS "loan_repayments_loan_idx" ON "bank"."loan_repayments" ("loan_id", "status");

-- ─────────────────────────────────────────────────────────────────────────────
-- MARGIN CALLS — one row per call, so "was the borrower warned before their
-- collateral was sold" is a row you can point at.
--
-- A margin call that exists only as a status flag on `loans` cannot answer that:
-- the flag is cleared when the call is cured, and the evidence goes with it. On
-- the day a borrower disputes a liquidation, the flag says nothing and this table
-- says when they were told, at what LTV, and whether delivery was attempted.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "bank"."loan_margin_calls" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "loan_id" uuid NOT NULL REFERENCES "bank"."loans" ("id"),
  "sequence" integer NOT NULL,
  "ltv_bps" integer NOT NULL,
  -- What the borrower must post, or repay, to clear the call. A quoted FIGURE at
  -- one instant, written once — not a holding, and never revised. The next mark
  -- writes a new row.
  "cure_collateral_amount" numeric(38, 18) NOT NULL,
  "called_at" timestamptz NOT NULL DEFAULT now(),
  "grace_expires_at" timestamptz NOT NULL,
  -- Delivery is a separate fact from the call itself. A call raised but not
  -- delivered is still a call, and it must be visible as such rather than
  -- indistinguishable from one the borrower read.
  "notified_at" timestamptz,
  "notify_error" text,
  "cleared_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "loan_margin_call_cure_non_negative" CHECK ("cure_collateral_amount" >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "loan_margin_calls_seq_idx" ON "bank"."loan_margin_calls" ("loan_id", "sequence");
CREATE INDEX IF NOT EXISTS "loan_margin_calls_open_idx" ON "bank"."loan_margin_calls" ("loan_id") WHERE "cleared_at" IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- ONE RUNG OF A LIQUIDATION LADDER.
--
-- `unique(loan_id, tranche)` is what makes the ladder possible AND safe. The
-- recipe this replaces keyed on the loan alone, which permitted exactly one
-- liquidation per loan for all time and therefore forbade partial liquidation
-- outright — so the only legal action was to dump the whole position into
-- whatever book existed, which is the behaviour that manufactures bad debt.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "bank"."loan_liquidations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "loan_id" uuid NOT NULL REFERENCES "bank"."loans" ("id"),
  "tranche" integer NOT NULL,
  "ltv_bps" integer NOT NULL,
  -- The mark this rung executed at. A price, recorded for the dispute nobody
  -- wants to have.
  "mark_price" numeric(38, 18) NOT NULL,
  -- Grace was waived (the insolvency branch) rather than served. Recorded so the
  -- one case that breaks the ordering rule is auditable per event, not inferred.
  "grace_waived" boolean NOT NULL DEFAULT false,
  -- RECORDS of one completed rung. The four allocations must sum to `proceeds`;
  -- `loanLiquidate` refuses the post otherwise, and the CHECK says so here too.
  "collateral_sold" numeric(38, 18) NOT NULL,
  "proceeds" numeric(38, 18) NOT NULL,
  "principal_repaid" numeric(38, 18) NOT NULL,
  "interest_repaid" numeric(38, 18) NOT NULL,
  "penalty" numeric(38, 18) NOT NULL,
  "surplus_returned" numeric(38, 18) NOT NULL,
  -- Principal the proceeds could not cover on a CLOSING rung. Covered by
  -- loanBadDebt out of the insurance fund, and this is the record of how much.
  "shortfall" numeric(38, 18) NOT NULL DEFAULT 0,
  "status" "bank"."loan_event_status" NOT NULL DEFAULT 'pending',
  "ledger_tx_id" text,
  "bad_debt_ledger_tx_id" text,
  "rejection_code" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "settled_at" timestamptz,

  CONSTRAINT "loan_liquidation_positive" CHECK ("collateral_sold" > 0 AND "proceeds" > 0 AND "mark_price" > 0),
  CONSTRAINT "loan_liquidation_non_negative" CHECK (
    "principal_repaid" >= 0 AND "interest_repaid" >= 0 AND "penalty" >= 0
    AND "surplus_returned" >= 0 AND "shortfall" >= 0
  ),
  -- EVERY UNIT REALISED BELONGS TO SOMEONE. An unallocated remainder is value the
  -- borrower's collateral produced that nobody has claimed.
  CONSTRAINT "loan_liquidation_fully_allocated" CHECK (
    "principal_repaid" + "interest_repaid" + "penalty" + "surplus_returned" = "proceeds"
  ),
  -- A surplus and a shortfall in the same rung is arithmetically impossible and
  -- would mean the waterfall paid the borrower before the reserve.
  CONSTRAINT "loan_liquidation_no_surplus_with_shortfall" CHECK ("surplus_returned" = 0 OR "shortfall" = 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "loan_liquidations_tranche_idx" ON "bank"."loan_liquidations" ("loan_id", "tranche");
CREATE INDEX IF NOT EXISTS "loan_liquidations_loan_idx" ON "bank"."loan_liquidations" ("loan_id", "status");
