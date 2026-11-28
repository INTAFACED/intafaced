-- svc-bank — business banking honest partial (bank.business / §31:811)
--
-- Maker/checker for over-threshold transfers on a corporate account.
-- No balance column. Value moves only via bankTransfer after dual approval.
-- An approval uses the account's asset, and its two spaces are different.
-- Full payroll / KYB / expense cards / invoicing remain residual or §13.

CREATE TYPE "bank"."business_member_role" AS ENUM ('admin', 'maker', 'checker');
CREATE TYPE "bank"."business_approval_status" AS ENUM ('pending', 'approved', 'rejected', 'cancelled');

CREATE TABLE IF NOT EXISTS "bank"."business_accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" text NOT NULL,
  "asset_id" text NOT NULL,
  -- Spend at or above this amount requires a checker who is not the maker.
  "spend_threshold" numeric(38, 18) NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "business_accounts_threshold_positive" CHECK ("spend_threshold" > 0),
  CONSTRAINT "business_accounts_status_ck" CHECK ("status" IN ('active', 'closed')),
  CONSTRAINT "business_accounts_id_asset_key" UNIQUE ("id", "asset_id")
);

CREATE TABLE IF NOT EXISTS "bank"."business_members" (
  "account_id" uuid NOT NULL REFERENCES "bank"."business_accounts" ("id"),
  "user_id" text NOT NULL,
  "role" "bank"."business_member_role" NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("account_id", "user_id")
);

CREATE INDEX IF NOT EXISTS "business_members_user_idx"
  ON "bank"."business_members" ("user_id");

-- Pending (or decided) dual-control transfer. Amount is an INSTRUCTION record.
CREATE TABLE IF NOT EXISTS "bank"."business_approvals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "bank"."business_accounts" ("id"),
  "maker_user_id" text NOT NULL,
  "checker_user_id" text,
  "from_space_id" uuid NOT NULL,
  "to_space_id" uuid NOT NULL,
  "asset_id" text NOT NULL,
  "amount" numeric(38, 18) NOT NULL,
  "status" "bank"."business_approval_status" NOT NULL DEFAULT 'pending',
  "transfer_id" text,
  "ledger_tx_id" text,
  "rejection_code" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "decided_at" timestamptz,
  CONSTRAINT "business_approvals_amount_positive" CHECK ("amount" > 0),
  CONSTRAINT "business_approvals_account_asset_fk" FOREIGN KEY ("account_id", "asset_id") REFERENCES "bank"."business_accounts" ("id", "asset_id"),
  CONSTRAINT "business_approvals_spaces_distinct" CHECK ("from_space_id" <> "to_space_id")
);

CREATE INDEX IF NOT EXISTS "business_approvals_account_status_idx"
  ON "bank"."business_approvals" ("account_id", "status");
