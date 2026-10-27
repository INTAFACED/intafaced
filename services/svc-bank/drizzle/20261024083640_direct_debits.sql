-- Direct Debit mandates, their collections and refund requests (BK-xfer-11, J-bank-06 #4).
--
-- A mandate is a creditor's standing permission to collect from one person's account, set up by the creditor through the
-- direct debit scheme. The person can block it, and unblock it later. A collection is one presentment by the creditor:
-- it is upcoming until it is due, then collected (one debit through the ledger, key `dd:<mandate>:<collection>`), failed
-- (the ledger refused it, nothing posted), or rejected (the mandate was blocked, nothing posted). A replayed presentment
-- is one row by (mandate_id, collection_id). No balance lives here: the amount is what the creditor asked for.
CREATE TABLE IF NOT EXISTS "bank"."dd_mandates" (
  "id"             text PRIMARY KEY,
  "user_id"        uuid NOT NULL,
  "scheme"         text NOT NULL,
  "creditor_id"    text NOT NULL,
  "creditor_name"  text NOT NULL,
  "reference"      text NOT NULL,
  "asset_id"       text NOT NULL,
  "status"         text NOT NULL DEFAULT 'active',
  "blocked_at"     timestamptz,
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  "updated_at"     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "dd_mandates_status_ck" CHECK ("status" IN ('active', 'blocked')),
  CONSTRAINT "dd_mandates_blocked_at_ck" CHECK (("status" = 'blocked') = ("blocked_at" IS NOT NULL)),
  -- No ':' in an id: a collection's ledger key is `dd:<mandate>:<collection>`, so one may never read as another.
  CONSTRAINT "dd_mandates_id_ck" CHECK ("id" ~ '^[A-Za-z0-9._-]{1,64}$'),
  CONSTRAINT "dd_mandates_reference_ck" CHECK (length("reference") BETWEEN 1 AND 140),
  CONSTRAINT "dd_mandates_creditor_ck" CHECK (length("creditor_id") BETWEEN 1 AND 64 AND length("creditor_name") BETWEEN 1 AND 140)
);
CREATE INDEX IF NOT EXISTS "dd_mandates_user_idx" ON "bank"."dd_mandates" ("user_id", "created_at");

CREATE TABLE IF NOT EXISTS "bank"."dd_collections" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "mandate_id"     text NOT NULL REFERENCES "bank"."dd_mandates"("id"),
  "collection_id"  text NOT NULL,
  "user_id"        uuid NOT NULL,
  "asset_id"       text NOT NULL,
  "amount"         numeric(38, 18) NOT NULL,
  "due_at"         timestamptz NOT NULL,
  "status"         text NOT NULL DEFAULT 'upcoming',
  "failure_code"   text,
  "ledger_tx_id"   text,
  "presented_at"   timestamptz NOT NULL DEFAULT now(),
  "settled_at"     timestamptz,
  -- The refund guarantee window, fixed when the debit was collected: a later change to the period never moves it.
  "guarantee_ends_at" timestamptz,
  CONSTRAINT "dd_collections_once_uq" UNIQUE ("mandate_id", "collection_id"),
  CONSTRAINT "dd_collections_amount_positive_ck" CHECK ("amount" > 0),
  CONSTRAINT "dd_collections_collection_id_ck" CHECK ("collection_id" ~ '^[A-Za-z0-9._-]{1,64}$'),
  CONSTRAINT "dd_collections_status_ck" CHECK ("status" IN ('upcoming', 'processing', 'collected', 'failed', 'rejected')),
  -- A collected row names the ledger entry it posted; nothing else does.
  CONSTRAINT "dd_collections_posted_ck" CHECK (("status" = 'collected') = ("ledger_tx_id" IS NOT NULL)),
  CONSTRAINT "dd_collections_guarantee_ck" CHECK ("guarantee_ends_at" IS NULL OR "status" = 'collected'),
  CONSTRAINT "dd_collections_failure_ck" CHECK (("status" IN ('failed', 'rejected')) = ("failure_code" IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS "dd_collections_due_idx" ON "bank"."dd_collections" ("due_at") WHERE "status" IN ('upcoming', 'processing');
CREATE INDEX IF NOT EXISTS "dd_collections_user_idx" ON "bank"."dd_collections" ("user_id", "due_at");

-- One refund request per collected debit. Support reads them; the credit back (`dd-refund:<collection>`) is the scheme's
-- answer and is not in this table.
CREATE TABLE IF NOT EXISTS "bank"."dd_refund_requests" (
  "collection_row_id" uuid PRIMARY KEY REFERENCES "bank"."dd_collections"("id"),
  "user_id"           uuid NOT NULL,
  "reason"            text NOT NULL,
  "status"            text NOT NULL DEFAULT 'requested',
  "guarantee_ends_at" timestamptz NOT NULL,
  "requested_at"      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "dd_refund_requests_status_ck" CHECK ("status" IN ('requested')),
  CONSTRAINT "dd_refund_requests_reason_ck" CHECK (length("reason") BETWEEN 1 AND 500)
);
