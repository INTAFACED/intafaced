-- Business bill inbox, hand review and duplicate flags (BK-bill-01).
--
-- A bill is a document and an obligation record. No value moves here and no ledger row is written; payment is BK-bill-03.
-- Intake is keyed `bill-in:<accountId>:<sha256>`, so the same file sent twice to one business is one bill. The payee,
-- reference, amount, asset and due date are blank until a member types them on review. `payee_norm` and `reference_norm`
-- hold the trimmed, lower-cased text the duplicate check compares (normalised in src/business/bills/bill-intake.ts).
-- An admin's "not a duplicate" is one row per pair, smaller id first.
--
-- Reversal: 0051_business_bills.down.sql

CREATE TABLE IF NOT EXISTS "bank"."business_bills" (
  "id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL REFERENCES "bank"."business_accounts" ("id"),
  "intake_key" text NOT NULL,
  "source" text NOT NULL,
  "status" text NOT NULL,
  "file_name" text NOT NULL,
  "file_type" text NOT NULL,
  "file_size" integer NOT NULL,
  "file_sha256" text NOT NULL,
  "file_bytes" bytea NOT NULL,
  "received_by" text NOT NULL,
  "payee" text,
  "payee_norm" text,
  "reference" text,
  "reference_norm" text,
  "amount" numeric(36, 18),
  "asset_id" text,
  "due_date" date,
  "reviewed_by" text,
  "reviewed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "business_bills_intake_key_uq" UNIQUE ("intake_key"),
  CONSTRAINT "business_bills_source_ck" CHECK ("source" IN ('upload', 'email')),
  CONSTRAINT "business_bills_status_ck" CHECK ("status" IN ('unreviewed', 'reviewed', 'approved', 'paid')),
  CONSTRAINT "business_bills_file_ck" CHECK ("file_sha256" ~ '^[0-9a-f]{64}$' AND "file_size" > 0),
  CONSTRAINT "business_bills_amount_ck" CHECK ("amount" IS NULL OR "amount" > 0),
  CONSTRAINT "business_bills_reviewed_ck" CHECK (
    ("status" = 'unreviewed')
    OR ("payee" IS NOT NULL AND "amount" IS NOT NULL AND "asset_id" IS NOT NULL AND "due_date" IS NOT NULL AND "reviewed_by" IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS "business_bills_inbox_idx"
  ON "bank"."business_bills" ("account_id", "status", "due_date", "created_at", "id");
CREATE INDEX IF NOT EXISTS "business_bills_payee_ref_idx"
  ON "bank"."business_bills" ("account_id", "payee_norm", "reference_norm");
CREATE INDEX IF NOT EXISTS "business_bills_amount_due_idx"
  ON "bank"."business_bills" ("account_id", "amount", "asset_id", "due_date");

CREATE TABLE IF NOT EXISTS "bank"."business_bill_not_duplicates" (
  "account_id" uuid NOT NULL REFERENCES "bank"."business_accounts" ("id"),
  "bill_id" uuid NOT NULL REFERENCES "bank"."business_bills" ("id"),
  "other_bill_id" uuid NOT NULL REFERENCES "bank"."business_bills" ("id"),
  "marked_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("bill_id", "other_bill_id"),
  CONSTRAINT "business_bill_not_duplicates_order_ck" CHECK ("bill_id" < "other_bill_id")
);
