-- A business's supplier bills (J-bank-20; BK-bill-01 to BK-bill-03). The business's money is the partner bank's
-- (OWNER 226): paying a bill is one instruction to the partner under `bank.business.bill-pay:<bill id>:<attempt>`,
-- stored here before it is sent and sent once; a split or a category is our own record beside that one payment; a
-- payment the partner returns is given back once under `bank.business.bill-return:<payment id>`. The ledger posts
-- nothing. These tables hold bills, vendors, limits, approvals and payment instructions; never a balance.
--
-- Reversal: 20261116030000_business_bills.down.sql

-- A bill received into the business's inbox. Its id is the intake's business key: the same upload sent again is the
-- same bill. A bill that looks like one already received (the same file, the same vendor and reference, or the same
-- amount and due date) names it in duplicate_of and cannot go to payment until someone clears the flag.
CREATE TABLE IF NOT EXISTS "bank"."business_bills" (
  "id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL REFERENCES "bank"."business_accounts" ("id"),
  "created_by" text NOT NULL,
  "file_name" text NOT NULL,
  "content_type" text NOT NULL,
  "file_sha256" text NOT NULL,
  "file_size" integer NOT NULL,
  "file" bytea NOT NULL,
  -- What the bill reader read, labelled with the reader that read it; null when no reader is set.
  "extracted" jsonb,
  "vendor" text,
  "reference" text,
  "amount" numeric(38, 18),
  "due_date" date,
  "status" text NOT NULL DEFAULT 'inbox',
  -- Each time a bill comes back to the inbox (declined or returned) its approvals start again in a new round.
  "round" integer NOT NULL DEFAULT 1,
  "approvals_needed" integer NOT NULL DEFAULT 0,
  "rule_id" uuid REFERENCES "bank"."business_payment_rules" ("id"),
  "preapproved" boolean NOT NULL DEFAULT false,
  "submitted_by" text,
  "submitted_at" timestamptz,
  "duplicate_of" uuid REFERENCES "bank"."business_bills" ("id"),
  "duplicate_cleared_by" text,
  "duplicate_cleared_at" timestamptz,
  -- Why it came back to the inbox: the partner's answer, as the partner gave it.
  "back_reason" text,
  "back_reason_text" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "business_bills_status_ck" CHECK ("status" IN ('inbox', 'awaiting_approval', 'approved', 'scheduled', 'paying', 'paid')),
  CONSTRAINT "business_bills_sha_ck" CHECK ("file_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "business_bills_size_ck" CHECK ("file_size" BETWEEN 1 AND 1048576 AND octet_length("file") = "file_size"),
  CONSTRAINT "business_bills_amount_ck" CHECK ("amount" IS NULL OR "amount" > 0),
  CONSTRAINT "business_bills_vendor_ck" CHECK ("vendor" IS NULL OR char_length("vendor") BETWEEN 1 AND 128),
  CONSTRAINT "business_bills_reference_ck" CHECK ("reference" IS NULL OR char_length("reference") BETWEEN 1 AND 64),
  CONSTRAINT "business_bills_needed_ck" CHECK ("approvals_needed" BETWEEN 0 AND 5),
  CONSTRAINT "business_bills_not_self_ck" CHECK ("duplicate_of" IS NULL OR "duplicate_of" <> "id"),
  CONSTRAINT "business_bills_cleared_ck" CHECK (("duplicate_cleared_by" IS NULL) = ("duplicate_cleared_at" IS NULL))
);
CREATE INDEX IF NOT EXISTS "business_bills_account_idx" ON "bank"."business_bills" ("account_id", "created_at" DESC);

-- One approval of one bill in one round by one person: the primary key makes approvers distinct
-- (`bill-approve:<bill id>:<approver id>` in that round).
CREATE TABLE IF NOT EXISTS "bank"."business_bill_approvals" (
  "bill_id" uuid NOT NULL REFERENCES "bank"."business_bills" ("id"),
  "round" integer NOT NULL,
  "approver_user_id" text NOT NULL,
  "approved_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("bill_id", "round", "approver_user_id")
);

-- A vendor the business pre-approved: a bill from them up to the cap goes to payment without approvers.
CREATE TABLE IF NOT EXISTS "bank"."business_bill_vendors" (
  "account_id" uuid NOT NULL REFERENCES "bank"."business_accounts" ("id"),
  "name" text NOT NULL,
  "cap" numeric(38, 18) NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "business_bill_vendors_name_ck" CHECK (char_length("name") BETWEEN 1 AND 128),
  CONSTRAINT "business_bill_vendors_cap_ck" CHECK ("cap" > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS "business_bill_vendors_name_uq" ON "bank"."business_bill_vendors" ("account_id", lower("name"));

-- The business's own Bill Pay limits. A blank limit is not set, never unlimited: every payment refuses until all are set.
CREATE TABLE IF NOT EXISTS "bank"."business_bill_limits" (
  "account_id" uuid PRIMARY KEY REFERENCES "bank"."business_accounts" ("id"),
  "per_payment" numeric(38, 18),
  "daily" numeric(38, 18),
  "monthly" numeric(38, 18),
  "updated_by" text NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "business_bill_limits_positive_ck" CHECK (
    ("per_payment" IS NULL OR "per_payment" > 0) AND ("daily" IS NULL OR "daily" > 0) AND ("monthly" IS NULL OR "monthly" > 0)
  )
);

-- One attempt to pay one bill: one instruction to the partner under its key, stored before it is sent. Scheduled, it
-- waits for its date and can be cancelled until it is sent; a cancelled one never reaches the partner.
CREATE TABLE IF NOT EXISTS "bank"."business_bill_payments" (
  "id" uuid PRIMARY KEY,
  "bill_id" uuid NOT NULL REFERENCES "bank"."business_bills" ("id"),
  "account_id" uuid NOT NULL REFERENCES "bank"."business_accounts" ("id"),
  "attempt" integer NOT NULL,
  "made_by" text NOT NULL,
  "asset_id" text NOT NULL,
  "amount" numeric(38, 18) NOT NULL,
  "scheduled_for" date,
  "status" text NOT NULL,
  "partner_key" text NOT NULL UNIQUE,
  "partner_move_id" text UNIQUE,
  "partner_reason" text,
  "partner_reason_text" text,
  "return_key" text NOT NULL UNIQUE,
  "return_move_id" text UNIQUE,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "sent_at" timestamptz,
  "cancelled_at" timestamptz,
  "answered_at" timestamptz,
  CONSTRAINT "business_bill_payments_attempt_uq" UNIQUE ("bill_id", "attempt"),
  CONSTRAINT "business_bill_payments_amount_ck" CHECK ("amount" > 0),
  CONSTRAINT "business_bill_payments_status_ck" CHECK ("status" IN ('scheduled', 'sending', 'sent', 'cancelled', 'declined', 'returned')),
  CONSTRAINT "business_bill_payments_key_ck" CHECK ("partner_key" = 'bank.business.bill-pay:' || "bill_id"::text || ':' || "attempt"::text),
  CONSTRAINT "business_bill_payments_return_key_ck" CHECK ("return_key" = 'bank.business.bill-return:' || "id"::text),
  CONSTRAINT "business_bill_payments_moved_ck" CHECK (("status" IN ('sent', 'returned')) = ("partner_move_id" IS NOT NULL)),
  CONSTRAINT "business_bill_payments_returned_ck" CHECK (("status" = 'returned') = ("return_move_id" IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS "business_bill_payments_bill_idx" ON "bank"."business_bill_payments" ("bill_id", "attempt");
CREATE INDEX IF NOT EXISTS "business_bill_payments_due_idx" ON "bank"."business_bill_payments" ("scheduled_for") WHERE "status" = 'scheduled';

-- How a payment is categorised or split: our record beside the partner's one payment. The lines add up to its amount.
CREATE TABLE IF NOT EXISTS "bank"."business_bill_splits" (
  "payment_id" uuid NOT NULL REFERENCES "bank"."business_bill_payments" ("id"),
  "line" integer NOT NULL,
  "category" text NOT NULL,
  "amount" numeric(38, 18) NOT NULL,
  PRIMARY KEY ("payment_id", "line"),
  CONSTRAINT "business_bill_splits_category_ck" CHECK (char_length("category") BETWEEN 1 AND 64),
  CONSTRAINT "business_bill_splits_amount_ck" CHECK ("amount" > 0)
);
