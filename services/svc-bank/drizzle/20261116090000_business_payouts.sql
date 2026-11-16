-- A business pays its team and contractors in bulk (J-bank-21; BK-bpay-01, BK-bpay-02, RC-bank-05). The business's money
-- is the partner bank's (OWNER 226): a bulk run and a contractor batch are each one instruction to the partner under
-- their own key, stored here before it is sent and sent once; the lines beside it are our record. Recurring crypto
-- payroll is signed by the business's own wallet: INTAFACED holds no key and no vault, and keeps only the run, its
-- payslips and the wallet's signature. The ledger posts nothing. These tables hold instructions and records; never a
-- balance.
--
-- Reversal: 20261116090000_business_payouts.down.sql

-- A bulk payment run imported from a CSV. Its id is the run key's business part: one run is one partner instruction,
-- `bank.business.bulk-pay:<run id>`. A run's lines are the valid lines of its file; the invalid ones are its issues
-- (the validation report) and send nothing.
CREATE TABLE IF NOT EXISTS "bank"."business_bulk_runs" (
  "id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL REFERENCES "bank"."business_accounts" ("id"),
  "created_by" text NOT NULL,
  "file_sha256" text NOT NULL,
  "asset_id" text NOT NULL,
  "amount" numeric(38, 18) NOT NULL,
  "status" text NOT NULL DEFAULT 'draft',
  "approvals_needed" integer NOT NULL DEFAULT 0,
  -- The business's own threshold when the run was confirmed: at or above it the run needs an approver.
  "threshold" numeric(38, 18),
  "confirmed_by" text,
  "confirmed_at" timestamptz,
  "partner_key" text NOT NULL UNIQUE,
  "partner_move_id" text,
  "partner_reason" text,
  "partner_reason_text" text,
  "sent_at" timestamptz,
  "answered_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "business_bulk_runs_status_ck" CHECK ("status" IN ('draft', 'awaiting_approval', 'sending', 'sent', 'declined')),
  CONSTRAINT "business_bulk_runs_sha_ck" CHECK ("file_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "business_bulk_runs_amount_ck" CHECK ("amount" >= 0),
  CONSTRAINT "business_bulk_runs_key_ck" CHECK ("partner_key" = 'bank.business.bulk-pay:' || "id"::text),
  CONSTRAINT "business_bulk_runs_needed_ck" CHECK ("approvals_needed" BETWEEN 0 AND 5)
);
CREATE INDEX IF NOT EXISTS "business_bulk_runs_account_idx" ON "bank"."business_bulk_runs" ("account_id", "created_at");

CREATE TABLE IF NOT EXISTS "bank"."business_bulk_lines" (
  "run_id" uuid NOT NULL REFERENCES "bank"."business_bulk_runs" ("id"),
  -- The line's number in the file, the header not counted.
  "line" integer NOT NULL,
  "name" text NOT NULL,
  "iban" text NOT NULL,
  "amount" numeric(38, 18) NOT NULL,
  "reference" text,
  PRIMARY KEY ("run_id", "line"),
  CONSTRAINT "business_bulk_lines_amount_ck" CHECK ("amount" > 0)
);

-- The validation report: each line of the file that sends nothing, with its code.
CREATE TABLE IF NOT EXISTS "bank"."business_bulk_issues" (
  "run_id" uuid NOT NULL REFERENCES "bank"."business_bulk_runs" ("id"),
  "line" integer NOT NULL,
  "code" text NOT NULL,
  "detail" text NOT NULL,
  "raw" text NOT NULL,
  PRIMARY KEY ("run_id", "line")
);

CREATE TABLE IF NOT EXISTS "bank"."business_bulk_approvals" (
  "run_id" uuid NOT NULL REFERENCES "bank"."business_bulk_runs" ("id"),
  "approver_user_id" text NOT NULL,
  "approved_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("run_id", "approver_user_id")
);

-- A contractor of the business: where a payout goes (SEPA: the holder and the IBAN) and, for crypto payroll, the
-- contractor's own wallet address. Added by the business, or by the contractor through a one-use onboarding link.
CREATE TABLE IF NOT EXISTS "bank"."business_contractors" (
  "id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL REFERENCES "bank"."business_accounts" ("id"),
  "name" text NOT NULL,
  "email" text,
  "iban" text,
  "wallet_address" text,
  "onboarded" text NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "business_contractors_onboarded_ck" CHECK ("onboarded" IN ('business', 'self')),
  CONSTRAINT "business_contractors_name_ck" CHECK (char_length("name") BETWEEN 1 AND 140),
  CONSTRAINT "business_contractors_wallet_ck" CHECK ("wallet_address" IS NULL OR "wallet_address" ~ '^0x[0-9a-f]{40}$')
);
CREATE INDEX IF NOT EXISTS "business_contractors_account_idx" ON "bank"."business_contractors" ("account_id", "created_at");

CREATE TABLE IF NOT EXISTS "bank"."business_contractor_invoices" (
  "id" uuid PRIMARY KEY,
  "contractor_id" uuid NOT NULL REFERENCES "bank"."business_contractors" ("id"),
  "account_id" uuid NOT NULL REFERENCES "bank"."business_accounts" ("id"),
  "number" text NOT NULL,
  "asset_id" text NOT NULL,
  "amount" numeric(38, 18) NOT NULL,
  "due_date" date,
  "status" text NOT NULL DEFAULT 'open',
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "business_contractor_invoices_status_ck" CHECK ("status" IN ('open', 'in_batch', 'paid')),
  CONSTRAINT "business_contractor_invoices_amount_ck" CHECK ("amount" > 0),
  CONSTRAINT "business_contractor_invoices_number_ck" CHECK (char_length("number") BETWEEN 1 AND 64)
);
CREATE UNIQUE INDEX IF NOT EXISTS "business_contractor_invoices_number_uq"
  ON "bank"."business_contractor_invoices" ("contractor_id", lower("number"));

-- A contractor batch: the intent row, written before anything reaches the partner. One partner instruction under
-- `bank.business.contractor-batch:<batch id>`; with no partner payout rail it is kept, refused with `rail.bank`.
CREATE TABLE IF NOT EXISTS "bank"."business_contractor_batches" (
  "id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL REFERENCES "bank"."business_accounts" ("id"),
  "created_by" text NOT NULL,
  "asset_id" text NOT NULL,
  "amount" numeric(38, 18) NOT NULL,
  "status" text NOT NULL,
  "approvals_needed" integer NOT NULL DEFAULT 0,
  "rule_id" uuid REFERENCES "bank"."business_payment_rules" ("id"),
  "partner_key" text NOT NULL UNIQUE,
  "partner_move_id" text,
  "refusal_code" text,
  "partner_reason_text" text,
  "sent_at" timestamptz,
  "answered_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "business_contractor_batches_status_ck"
    CHECK ("status" IN ('awaiting_approval', 'sending', 'sent', 'declined', 'refused')),
  CONSTRAINT "business_contractor_batches_amount_ck" CHECK ("amount" > 0),
  CONSTRAINT "business_contractor_batches_key_ck" CHECK ("partner_key" = 'bank.business.contractor-batch:' || "id"::text),
  CONSTRAINT "business_contractor_batches_needed_ck" CHECK ("approvals_needed" BETWEEN 0 AND 5)
);

CREATE TABLE IF NOT EXISTS "bank"."business_contractor_batch_lines" (
  "batch_id" uuid NOT NULL REFERENCES "bank"."business_contractor_batches" ("id"),
  "invoice_id" uuid NOT NULL REFERENCES "bank"."business_contractor_invoices" ("id"),
  "amount" numeric(38, 18) NOT NULL,
  PRIMARY KEY ("batch_id", "invoice_id")
);

CREATE TABLE IF NOT EXISTS "bank"."business_contractor_batch_approvals" (
  "batch_id" uuid NOT NULL REFERENCES "bank"."business_contractor_batches" ("id"),
  "approver_user_id" text NOT NULL,
  "approved_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("batch_id", "approver_user_id")
);

-- A one-use link a contractor opens to add themselves. Only the token's hash is kept.
CREATE TABLE IF NOT EXISTS "bank"."business_contractor_invites" (
  "id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL REFERENCES "bank"."business_accounts" ("id"),
  "token_sha256" text NOT NULL UNIQUE,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "joined_by" text,
  "contractor_id" uuid REFERENCES "bank"."business_contractors" ("id"),
  "used_at" timestamptz
);

-- The business's own wallet for crypto payroll, proven by its signature over an offered message. One per business.
CREATE TABLE IF NOT EXISTS "bank"."business_payroll_wallet_offers" (
  "id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL REFERENCES "bank"."business_accounts" ("id"),
  "address" text NOT NULL,
  "message" text NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "used_at" timestamptz,
  CONSTRAINT "business_payroll_wallet_offers_address_ck" CHECK ("address" ~ '^0x[0-9a-f]{40}$')
);
CREATE TABLE IF NOT EXISTS "bank"."business_payroll_wallets" (
  "account_id" uuid PRIMARY KEY REFERENCES "bank"."business_accounts" ("id"),
  "address" text NOT NULL,
  "offer_id" uuid NOT NULL REFERENCES "bank"."business_payroll_wallet_offers" ("id"),
  "signature" text NOT NULL,
  "connected_by" text NOT NULL,
  "connected_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "business_payroll_wallets_address_ck" CHECK ("address" ~ '^0x[0-9a-f]{40}$')
);

-- A recurring crypto payroll: who is paid how much, monthly on a day. Each run is signed by the business's own wallet.
CREATE TABLE IF NOT EXISTS "bank"."business_crypto_payrolls" (
  "id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL REFERENCES "bank"."business_accounts" ("id"),
  "name" text NOT NULL,
  "asset_id" text NOT NULL,
  "day_of_month" integer NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "business_crypto_payrolls_day_ck" CHECK ("day_of_month" BETWEEN 1 AND 28),
  CONSTRAINT "business_crypto_payrolls_name_ck" CHECK (char_length("name") BETWEEN 1 AND 128)
);
CREATE TABLE IF NOT EXISTS "bank"."business_crypto_payroll_members" (
  "payroll_id" uuid NOT NULL REFERENCES "bank"."business_crypto_payrolls" ("id"),
  "contractor_id" uuid NOT NULL REFERENCES "bank"."business_contractors" ("id"),
  "amount" numeric(38, 18) NOT NULL,
  PRIMARY KEY ("payroll_id", "contractor_id"),
  CONSTRAINT "business_crypto_payroll_members_amount_ck" CHECK ("amount" > 0)
);
-- One run per payroll per month, under its run key. Its message is what the business's wallet signs.
CREATE TABLE IF NOT EXISTS "bank"."business_crypto_payroll_runs" (
  "id" uuid PRIMARY KEY,
  "payroll_id" uuid NOT NULL REFERENCES "bank"."business_crypto_payrolls" ("id"),
  "period" text NOT NULL,
  "run_key" text NOT NULL UNIQUE,
  "wallet_address" text NOT NULL,
  "message" text NOT NULL,
  "amount" numeric(38, 18) NOT NULL,
  "status" text NOT NULL DEFAULT 'awaiting_signature',
  "signature" text,
  "signed_at" timestamptz,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "business_crypto_payroll_runs_period_ck" CHECK ("period" ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT "business_crypto_payroll_runs_status_ck" CHECK ("status" IN ('awaiting_signature', 'signed')),
  CONSTRAINT "business_crypto_payroll_runs_key_ck" CHECK ("run_key" = 'bank.business.crypto-payroll:' || "payroll_id"::text || ':' || "period"),
  UNIQUE ("payroll_id", "period")
);
CREATE TABLE IF NOT EXISTS "bank"."business_crypto_payslips" (
  "run_id" uuid NOT NULL REFERENCES "bank"."business_crypto_payroll_runs" ("id"),
  "contractor_id" uuid NOT NULL REFERENCES "bank"."business_contractors" ("id"),
  "name" text NOT NULL,
  "wallet_address" text NOT NULL,
  "asset_id" text NOT NULL,
  "amount" numeric(38, 18) NOT NULL,
  PRIMARY KEY ("run_id", "contractor_id")
);
