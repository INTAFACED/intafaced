-- A business bank team and its approval rules (J-bank-19; BK-biz-01 to BK-biz-04). The business's money is the partner
-- bank's (OWNER 226): a payment is one instruction to the partner, sent once under its business key after the approvals
-- its rule asks for, and the ledger posts nothing. These tables hold who may do what, the rules, and each payment's
-- instruction and approvals; never a balance.
--
-- Reversal: 20261115235523_business_team_rules.down.sql

-- The person who opened the business. Only they approve an advisor. Rows opened before this column name their first
-- administrator.
ALTER TABLE "bank"."business_accounts" ADD COLUMN IF NOT EXISTS "owner_user_id" text;
UPDATE "bank"."business_accounts" a
   SET "owner_user_id" = (
     SELECT m."user_id" FROM "bank"."business_members" m
      WHERE m."account_id" = a."id" AND m."role" = 'admin'
      ORDER BY m."created_at" ASC, m."user_id" ASC
      LIMIT 1)
 WHERE a."owner_user_id" IS NULL;

-- A role the business names itself, with the permissions it grants. A member who holds one has these on the team doors, and business_members.role is set to the built-in role it fits (never wider), which every older business door reads.
CREATE TABLE IF NOT EXISTS "bank"."business_custom_roles" (
  "id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL REFERENCES "bank"."business_accounts" ("id"),
  "name" text NOT NULL,
  "permissions" text[] NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "business_custom_roles_name_ck" CHECK (char_length("name") BETWEEN 1 AND 64),
  CONSTRAINT "business_custom_roles_permissions_ck" CHECK (
    cardinality("permissions") >= 1
    AND "permissions" <@ ARRAY['view', 'export', 'propose', 'approve', 'manage_team', 'team_spend']::text[]
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS "business_custom_roles_name_uq"
  ON "bank"."business_custom_roles" ("account_id", lower("name"));

-- A department the business groups its members into. A blank budget is not set, never zero.
CREATE TABLE IF NOT EXISTS "bank"."business_departments" (
  "id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL REFERENCES "bank"."business_accounts" ("id"),
  "name" text NOT NULL,
  "budget" numeric(38, 18),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "business_departments_name_ck" CHECK (char_length("name") BETWEEN 1 AND 64),
  CONSTRAINT "business_departments_budget_ck" CHECK ("budget" IS NULL OR "budget" > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS "business_departments_name_uq"
  ON "bank"."business_departments" ("account_id", lower("name"));

ALTER TABLE "bank"."business_members" ADD COLUMN IF NOT EXISTS "custom_role_id" uuid REFERENCES "bank"."business_custom_roles" ("id");
ALTER TABLE "bank"."business_members" ADD COLUMN IF NOT EXISTS "department_id" uuid REFERENCES "bank"."business_departments" ("id");
-- An advisor sees the business and nothing more, once its owner has approved them.
ALTER TABLE "bank"."business_members" ADD COLUMN IF NOT EXISTS "advisor" boolean NOT NULL DEFAULT false;

-- An advisor someone asked to add. Until the owner approves, the advisor is not a member and reads nothing.
CREATE TABLE IF NOT EXISTS "bank"."business_advisors" (
  "account_id" uuid NOT NULL REFERENCES "bank"."business_accounts" ("id"),
  "user_id" text NOT NULL,
  "added_by" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "decided_by" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "decided_at" timestamptz,
  PRIMARY KEY ("account_id", "user_id"),
  CONSTRAINT "business_advisors_status_ck" CHECK ("status" IN ('pending', 'approved')),
  CONSTRAINT "business_advisors_decided_ck" CHECK (("status" = 'pending') = ("decided_by" IS NULL))
);

-- An invitation to join, by email or by link. Only a hash of its link's secret is kept. It lasts the owner-set
-- BANK_BUSINESS_INVITE_MINUTES from when it was made, on the database clock.
CREATE TABLE IF NOT EXISTS "bank"."business_invites" (
  "id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL REFERENCES "bank"."business_accounts" ("id"),
  "kind" text NOT NULL,
  "email" text,
  "token_hash" text NOT NULL UNIQUE,
  "role" "bank"."business_member_role",
  "custom_role_id" uuid REFERENCES "bank"."business_custom_roles" ("id"),
  "invited_by" text NOT NULL,
  "status" text NOT NULL DEFAULT 'open',
  "expires_at" timestamptz NOT NULL,
  "accepted_by" text,
  "replaced_by" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "decided_at" timestamptz,
  CONSTRAINT "business_invites_kind_ck" CHECK (("kind" = 'email') = ("email" IS NOT NULL) AND "kind" IN ('email', 'link')),
  CONSTRAINT "business_invites_status_ck" CHECK ("status" IN ('open', 'accepted', 'revoked', 'replaced')),
  CONSTRAINT "business_invites_role_ck" CHECK (("role" IS NULL) <> ("custom_role_id" IS NULL)),
  CONSTRAINT "business_invites_accepted_ck" CHECK (("status" = 'accepted') = ("accepted_by" IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS "business_invites_account_idx" ON "bank"."business_invites" ("account_id", "created_at" DESC);

-- An approval rule: a payment over this amount, to this payee (or any), of this type (or any), needs this many distinct
-- approvers. Of every rule a payment matches, the one asking the most approvals applies.
CREATE TABLE IF NOT EXISTS "bank"."business_payment_rules" (
  "id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL REFERENCES "bank"."business_accounts" ("id"),
  "over_amount" numeric(38, 18) NOT NULL,
  "payee" text,
  "payment_type" text,
  "approvals" integer NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "business_payment_rules_over_ck" CHECK ("over_amount" >= 0),
  CONSTRAINT "business_payment_rules_approvals_ck" CHECK ("approvals" BETWEEN 1 AND 5),
  CONSTRAINT "business_payment_rules_type_ck" CHECK ("payment_type" IS NULL OR "payment_type" IN ('domestic', 'international', 'payroll'))
);
CREATE INDEX IF NOT EXISTS "business_payment_rules_account_idx" ON "bank"."business_payment_rules" ("account_id");

-- A payment proposed under the rules. Its id is the business key of its one partner instruction,
-- `bank.business.payment:<id>`, stored here before it is sent. It names the partner's move once sent; it never names a
-- ledger transaction, because the ledger posts nothing for money the partner holds.
CREATE TABLE IF NOT EXISTS "bank"."business_payments" (
  "id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL REFERENCES "bank"."business_accounts" ("id"),
  "maker_user_id" text NOT NULL,
  "payee" text NOT NULL,
  "payment_type" text NOT NULL,
  "asset_id" text NOT NULL,
  "amount" numeric(38, 18) NOT NULL,
  "rule_id" uuid REFERENCES "bank"."business_payment_rules" ("id"),
  "approvals_needed" integer NOT NULL,
  "status" text NOT NULL,
  "partner_key" text NOT NULL UNIQUE,
  "partner_move_id" text UNIQUE,
  "refusal_code" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "sent_at" timestamptz,
  CONSTRAINT "business_payments_amount_ck" CHECK ("amount" > 0),
  CONSTRAINT "business_payments_type_ck" CHECK ("payment_type" IN ('domestic', 'international', 'payroll')),
  CONSTRAINT "business_payments_payee_ck" CHECK (char_length("payee") BETWEEN 1 AND 128),
  CONSTRAINT "business_payments_needed_ck" CHECK ("approvals_needed" BETWEEN 0 AND 5),
  CONSTRAINT "business_payments_status_ck" CHECK ("status" IN ('pending', 'sending', 'sent', 'refused', 'rejected')),
  CONSTRAINT "business_payments_sent_ck" CHECK (("status" = 'sent') = ("partner_move_id" IS NOT NULL)),
  CONSTRAINT "business_payments_key_ck" CHECK ("partner_key" = 'bank.business.payment:' || "id"::text)
);
CREATE INDEX IF NOT EXISTS "business_payments_account_idx" ON "bank"."business_payments" ("account_id", "created_at" DESC);

-- One approval of one payment by one person: the primary key makes approvers distinct.
CREATE TABLE IF NOT EXISTS "bank"."business_payment_approvals" (
  "payment_id" uuid NOT NULL REFERENCES "bank"."business_payments" ("id"),
  "approver_user_id" text NOT NULL,
  "approved_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("payment_id", "approver_user_id")
);
