-- Personal send metadata, published transfer terms, and payment requests.
-- Reversal: 0036_personal_pay.down.sql
--
-- No balance column. personal_transfers.amount is the record of one send.
-- personal_transfer_terms is an operator-published policy (empty until published;
-- the service does not seed a fee or a limit). personal_requests.amount is the
-- amount asked for, not a holding.
-- A reserved row is an in-flight claim so a retry of the same transfer id
-- resumes one posting. It is not a second book.

CREATE TABLE IF NOT EXISTS "bank"."personal_transfer_terms" (
  "asset_id" text PRIMARY KEY,
  "per_transfer_limit" numeric(38, 18) NOT NULL,
  "daily_limit" numeric(38, 18) NOT NULL,
  "fee" numeric(38, 18) NOT NULL,
  "published_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "personal_transfer_terms_asset_ck" CHECK (length(btrim("asset_id")) BETWEEN 1 AND 16),
  CONSTRAINT "personal_transfer_terms_per_ck" CHECK ("per_transfer_limit" > 0),
  CONSTRAINT "personal_transfer_terms_daily_ck" CHECK ("daily_limit" > 0),
  CONSTRAINT "personal_transfer_terms_fee_ck" CHECK ("fee" >= 0)
);

CREATE TABLE IF NOT EXISTS "bank"."personal_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "idempotency_key" text NOT NULL,
  "payee_user_id" text NOT NULL,
  "payer_user_id" text NOT NULL,
  "asset_id" text NOT NULL,
  "amount" numeric(38, 18) NOT NULL,
  "note" text,
  "expires_at" timestamptz NOT NULL,
  "status" text NOT NULL,
  "claim_transfer_id" text,
  "ledger_tx_id" text,
  "payee_handle" text,
  "payer_handle" text,
  "notice_blocker" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "personal_requests_key_ck" CHECK (length(btrim("idempotency_key")) BETWEEN 8 AND 64),
  CONSTRAINT "personal_requests_parties_ck" CHECK ("payee_user_id" <> "payer_user_id"),
  CONSTRAINT "personal_requests_amount_ck" CHECK ("amount" > 0),
  CONSTRAINT "personal_requests_note_ck" CHECK (
    "note" IS NULL OR (char_length("note") BETWEEN 1 AND 140 AND "note" !~ '[[:cntrl:]]')
  ),
  CONSTRAINT "personal_requests_status_ck" CHECK ("status" IN ('open', 'paid', 'declined', 'cancelled')),
  CONSTRAINT "personal_requests_paid_tx_ck" CHECK (
    ("status" = 'paid' AND "ledger_tx_id" IS NOT NULL) OR ("status" <> 'paid' AND "ledger_tx_id" IS NULL)
  ),
  CONSTRAINT "personal_requests_idem_uq" UNIQUE ("payee_user_id", "idempotency_key")
);

CREATE INDEX IF NOT EXISTS "personal_requests_payer_idx"
  ON "bank"."personal_requests" ("payer_user_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "personal_requests_payee_idx"
  ON "bank"."personal_requests" ("payee_user_id", "created_at" DESC);

CREATE TABLE IF NOT EXISTS "bank"."personal_request_reminds" (
  "request_id" uuid NOT NULL REFERENCES "bank"."personal_requests" ("id"),
  "idempotency_key" text NOT NULL,
  "sequence" integer NOT NULL,
  "published_at" timestamptz,
  PRIMARY KEY ("request_id", "idempotency_key"),
  CONSTRAINT "personal_request_reminds_key_ck" CHECK (length(btrim("idempotency_key")) BETWEEN 8 AND 64),
  CONSTRAINT "personal_request_reminds_seq_ck" CHECK ("sequence" >= 2),
  CONSTRAINT "personal_request_reminds_seq_uq" UNIQUE ("request_id", "sequence")
);

CREATE TABLE IF NOT EXISTS "bank"."personal_transfers" (
  "transfer_id" text PRIMARY KEY,
  "ledger_tx_id" text,
  "from_user_id" text NOT NULL,
  -- The space that was debited, so a later sweep can require the booked
  -- entries to be this send and not some other movement under the same key.
  "from_space_id" uuid NOT NULL,
  "to_user_id" text NOT NULL,
  "asset_id" text NOT NULL,
  "amount" numeric(38, 18) NOT NULL,
  "note" text,
  "from_handle" text,
  "to_handle" text,
  "request_id" uuid REFERENCES "bank"."personal_requests" ("id"),
  "status" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "personal_transfers_id_ck" CHECK (length(btrim("transfer_id")) BETWEEN 8 AND 64),
  CONSTRAINT "personal_transfers_amount_ck" CHECK ("amount" > 0),
  CONSTRAINT "personal_transfers_note_ck" CHECK (
    "note" IS NULL OR (char_length("note") BETWEEN 1 AND 140 AND "note" !~ '[[:cntrl:]]')
  ),
  CONSTRAINT "personal_transfers_status_ck" CHECK ("status" IN ('reserved', 'posted')),
  CONSTRAINT "personal_transfers_posted_tx_ck" CHECK (
    ("status" = 'posted' AND "ledger_tx_id" IS NOT NULL) OR ("status" = 'reserved' AND "ledger_tx_id" IS NULL)
  ),
  CONSTRAINT "personal_transfers_ledger_uq" UNIQUE ("ledger_tx_id"),
  CONSTRAINT "personal_transfers_request_uq" UNIQUE ("request_id")
);

CREATE INDEX IF NOT EXISTS "personal_transfers_from_day_idx"
  ON "bank"."personal_transfers" ("from_user_id", "asset_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "personal_transfers_to_idx"
  ON "bank"."personal_transfers" ("to_user_id");
