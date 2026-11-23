-- Team changes and account controls for bank.business.
--
-- A member command is the caller's idempotency key. The role or removal is
-- applied once in the same transaction as the row. A retry reads the row and
-- does not apply the change again.
--
-- A control request is dual control for closing the account or changing the
-- spend threshold. The first administrator records it. A different administrator
-- confirms the same id and the same terms. Any administrator, including the
-- proposer, may withdraw a pending request (status cancelled). One pending
-- request per kind. These rows are instructions. They are not balances.
--
-- Reversal: 0034_business_team_controls.down.sql

CREATE TABLE IF NOT EXISTS "bank"."business_member_commands" (
  "id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL REFERENCES "bank"."business_accounts" ("id"),
  "actor_user_id" text NOT NULL,
  "target_user_id" text NOT NULL,
  "action" text NOT NULL,
  "role" "bank"."business_member_role",
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "business_member_commands_action_ck" CHECK ("action" IN ('remove', 'set_role')),
  CONSTRAINT "business_member_commands_role_ck" CHECK (
    ("action" = 'set_role' AND "role" IS NOT NULL)
    OR ("action" = 'remove' AND "role" IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS "business_member_commands_account_idx"
  ON "bank"."business_member_commands" ("account_id", "created_at");

CREATE TABLE IF NOT EXISTS "bank"."business_control_requests" (
  "id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL REFERENCES "bank"."business_accounts" ("id"),
  "kind" text NOT NULL,
  "spend_threshold" numeric(38, 18),
  "proposed_by" text NOT NULL,
  "confirmed_by" text,
  "status" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "decided_at" timestamptz,
  CONSTRAINT "business_control_kind_ck" CHECK ("kind" IN ('set_threshold', 'close')),
  CONSTRAINT "business_control_status_ck" CHECK ("status" IN ('pending', 'applied', 'cancelled')),
  CONSTRAINT "business_control_threshold_ck" CHECK (
    ("kind" = 'set_threshold' AND "spend_threshold" IS NOT NULL AND "spend_threshold" > 0)
    OR ("kind" = 'close' AND "spend_threshold" IS NULL)
  ),
  CONSTRAINT "business_control_confirm_ck" CHECK (
    ("status" = 'pending' AND "confirmed_by" IS NULL AND "decided_at" IS NULL)
    OR (
      "status" = 'applied'
      AND "confirmed_by" IS NOT NULL
      AND "decided_at" IS NOT NULL
      AND "confirmed_by" <> "proposed_by"
    )
    OR (
      "status" = 'cancelled'
      AND "confirmed_by" IS NOT NULL
      AND "decided_at" IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "business_control_one_pending"
  ON "bank"."business_control_requests" ("account_id", "kind")
  WHERE "status" = 'pending';

CREATE INDEX IF NOT EXISTS "business_control_account_idx"
  ON "bank"."business_control_requests" ("account_id", "created_at");
