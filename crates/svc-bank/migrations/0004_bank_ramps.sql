-- svc-bank — RAMPS (§8.1 / D-S-09), THE CRYPTO LEDGER HALF ONLY
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS MIGRATION DOES NOT CREATE: A FIAT RAMP OR A LIVE CHAIN WIRE
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `bank.ramps` splits cleanly in two (ADR 2026-08-04 bank vertical law).
--
-- CRYPTO LEG — tables below. Value enters/leaves the book through existing
-- ledger-client recipes (`deposit`, `withdrawHold`, `withdrawSettle`) against a
-- named rail boundary. No balance column. No chain broadcast from this service.
--
-- FIAT LEG — `socket.psp-partners`. A bank/PSP partner and money-transmission
-- permission are a contract and a licence. No table here pretends otherwise.
--
-- `simulated` is NOT NULL DEFAULT true: a row that outlives the composition root
-- must still say whether it was ever a live rail movement.

DO $$ BEGIN
  CREATE TYPE "bank"."ramp_direction" AS ENUM ('onramp', 'offramp');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "bank"."ramp_kind" AS ENUM ('crypto', 'fiat');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Reuses `bank.loan_event_status` (pending/settled/rejected) — same claim shape
-- as transfers and cards: pending = claimed before the ledger post.

-- ─────────────────────────────────────────────────────────────────────────────
-- ON-RAMP — value entering the book (operator-asserted for the ledger half).
--
-- Unique (rail, rail_ref) is the double-credit guard. recipes.deposit is keyed
-- the same way, so svc-bank and the ledger cannot disagree about "already
-- credited". A mismatch on amount/user/asset against an existing claim refuses.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "bank"."ramp_onramps" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" text NOT NULL,
  "asset_id" text NOT NULL,
  "amount" numeric(38, 18) NOT NULL,
  "kind" "bank"."ramp_kind" NOT NULL DEFAULT 'crypto',
  "rail" text NOT NULL,
  "rail_ref" text NOT NULL,
  "simulated" boolean NOT NULL DEFAULT true,
  "credited_by" text NOT NULL,
  "status" "bank"."loan_event_status" NOT NULL DEFAULT 'pending',
  "ledger_tx_id" text,
  "rejection_code" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "settled_at" timestamptz,

  CONSTRAINT "ramp_onramps_amount_positive" CHECK ("amount" > 0),
  CONSTRAINT "ramp_onramps_settled_has_tx_ck" CHECK (
    ("status" <> 'settled') OR ("ledger_tx_id" IS NOT NULL)
  ),
  CONSTRAINT "ramp_onramps_rejected_has_code_ck" CHECK (
    ("status" <> 'rejected') OR ("rejection_code" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "ramp_onramps_rail_ref_idx"
  ON "bank"."ramp_onramps" ("rail", "rail_ref");
CREATE INDEX IF NOT EXISTS "ramp_onramps_user_idx"
  ON "bank"."ramp_onramps" ("user_id", "created_at");
CREATE INDEX IF NOT EXISTS "ramp_onramps_status_idx"
  ON "bank"."ramp_onramps" ("status");

-- ─────────────────────────────────────────────────────────────────────────────
-- OFF-RAMP — value leaving the book. Ledger moves first (hold), then settle to
-- the rail boundary. This service does NOT broadcast to a chain; settle means
-- the value left OUR book. Live send is svc-pay / Class X.
--
-- Unique (user_id, client_ref) so a retried request is the same offramp.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "bank"."ramp_offramps" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" text NOT NULL,
  "asset_id" text NOT NULL,
  "amount" numeric(38, 18) NOT NULL,
  "kind" "bank"."ramp_kind" NOT NULL DEFAULT 'crypto',
  "rail" text NOT NULL,
  "destination_ref" text NOT NULL,
  "client_ref" text NOT NULL,
  "simulated" boolean NOT NULL DEFAULT true,
  "status" "bank"."loan_event_status" NOT NULL DEFAULT 'pending',
  "hold_ledger_tx_id" text,
  "settle_ledger_tx_id" text,
  "rejection_code" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "settled_at" timestamptz,

  CONSTRAINT "ramp_offramps_amount_positive" CHECK ("amount" > 0),
  CONSTRAINT "ramp_offramps_settled_has_tx_ck" CHECK (
    ("status" <> 'settled') OR (
      "hold_ledger_tx_id" IS NOT NULL AND "settle_ledger_tx_id" IS NOT NULL
    )
  ),
  CONSTRAINT "ramp_offramps_rejected_has_code_ck" CHECK (
    ("status" <> 'rejected') OR ("rejection_code" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "ramp_offramps_client_ref_idx"
  ON "bank"."ramp_offramps" ("user_id", "client_ref");
CREATE INDEX IF NOT EXISTS "ramp_offramps_user_idx"
  ON "bank"."ramp_offramps" ("user_id", "created_at");
CREATE INDEX IF NOT EXISTS "ramp_offramps_status_idx"
  ON "bank"."ramp_offramps" ("status");
