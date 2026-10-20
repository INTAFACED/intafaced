-- Multi-approval for withdrawals (W-withdraw-11, wallet-withdraw-037). NO BALANCE LIVES HERE: the ledger is the only book.
-- A request freezes the terms of one withdrawal (amount, asset, rail, destination, client reference) when it is submitted;
-- the later approvals only decide whether that exact withdrawal runs, under the same client reference and so the same
-- ledger keys. The policy is owner-set per (user, asset) in `withdrawal_approval_policy_events` and read from the latest
-- row, so with no row the user has no approval policy and a request refuses; nothing here has a default. A decision is one
-- row per approver, so the same person approving twice is one row. The event log records every step, append-only.
CREATE TABLE IF NOT EXISTS "pay"."withdrawal_approval_policy_events" (
  "seq" bigserial PRIMARY KEY,
  "user_id" text NOT NULL,
  "asset_id" text NOT NULL,
  "active" boolean NOT NULL,
  "team_account_id" uuid NOT NULL,
  "required_approvals" integer NOT NULL,
  "threshold" numeric(38,18) NOT NULL,
  "window_seconds" integer NOT NULL,
  "expiry_seconds" integer NOT NULL,
  "hold_at_submit" boolean NOT NULL,
  "set_by" text NOT NULL,
  "set_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "withdrawal_approval_policy_required_positive" CHECK ("required_approvals" >= 1),
  CONSTRAINT "withdrawal_approval_policy_threshold_positive" CHECK ("threshold" > 0),
  CONSTRAINT "withdrawal_approval_policy_window_positive" CHECK ("window_seconds" > 0),
  CONSTRAINT "withdrawal_approval_policy_expiry_positive" CHECK ("expiry_seconds" > 0),
  CONSTRAINT "withdrawal_approval_policy_text_ck" CHECK (length(btrim("asset_id")) > 0 AND length(btrim("set_by")) > 0)
);
CREATE INDEX IF NOT EXISTS "withdrawal_approval_policy_latest_idx"
  ON "pay"."withdrawal_approval_policy_events" ("user_id", "asset_id", "seq" DESC);

CREATE TABLE IF NOT EXISTS "pay"."withdrawal_approval_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" text NOT NULL,
  "client_ref" text NOT NULL,
  "asset_id" text NOT NULL,
  "amount" numeric(38,18) NOT NULL,
  "rail" text NOT NULL,
  "destination" jsonb NOT NULL,
  "team_account_id" uuid NOT NULL,
  "required_approvals" integer NOT NULL,
  "hold_at_submit" boolean NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "failure_code" text,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "decided_at" timestamptz,
  CONSTRAINT "withdrawal_approval_requests_ref_uq" UNIQUE ("user_id", "client_ref"),
  CONSTRAINT "withdrawal_approval_requests_amount_positive" CHECK ("amount" > 0),
  CONSTRAINT "withdrawal_approval_requests_required_positive" CHECK ("required_approvals" >= 1),
  CONSTRAINT "withdrawal_approval_requests_status_ck" CHECK ("status" IN
    ('pending', 'approved', 'executed', 'rejected', 'expired', 'canceled', 'failed')),
  CONSTRAINT "withdrawal_approval_requests_ref_ck" CHECK (length(btrim("client_ref")) > 0)
);
CREATE INDEX IF NOT EXISTS "withdrawal_approval_requests_team_idx"
  ON "pay"."withdrawal_approval_requests" ("team_account_id", "status", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "withdrawal_approval_requests_due_idx"
  ON "pay"."withdrawal_approval_requests" ("status", "expires_at");

CREATE TABLE IF NOT EXISTS "pay"."withdrawal_approval_decisions" (
  "request_id" uuid NOT NULL REFERENCES "pay"."withdrawal_approval_requests" ("id"),
  "approver_id" text NOT NULL,
  "decision" text NOT NULL,
  "decided_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("request_id", "approver_id"),
  CONSTRAINT "withdrawal_approval_decisions_ck" CHECK ("decision" IN ('approve', 'reject') AND length(btrim("approver_id")) > 0)
);

CREATE TABLE IF NOT EXISTS "pay"."withdrawal_approval_events" (
  "seq" bigserial PRIMARY KEY,
  "request_id" uuid NOT NULL REFERENCES "pay"."withdrawal_approval_requests" ("id"),
  "kind" text NOT NULL,
  "actor_id" text NOT NULL,
  "detail" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "withdrawal_approval_events_actor_not_blank" CHECK (length(btrim("actor_id")) > 0)
);
CREATE INDEX IF NOT EXISTS "withdrawal_approval_events_request_idx" ON "pay"."withdrawal_approval_events" ("request_id", "seq");

CREATE OR REPLACE FUNCTION "pay"."withdrawal_approvals_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END;
$$;
DROP TRIGGER IF EXISTS "withdrawal_approval_policy_events_append_only_trg" ON "pay"."withdrawal_approval_policy_events";
CREATE TRIGGER "withdrawal_approval_policy_events_append_only_trg" BEFORE UPDATE OR DELETE ON "pay"."withdrawal_approval_policy_events"
  FOR EACH ROW EXECUTE FUNCTION "pay"."withdrawal_approvals_append_only"();
DROP TRIGGER IF EXISTS "withdrawal_approval_decisions_append_only_trg" ON "pay"."withdrawal_approval_decisions";
CREATE TRIGGER "withdrawal_approval_decisions_append_only_trg" BEFORE UPDATE OR DELETE ON "pay"."withdrawal_approval_decisions"
  FOR EACH ROW EXECUTE FUNCTION "pay"."withdrawal_approvals_append_only"();
DROP TRIGGER IF EXISTS "withdrawal_approval_events_append_only_trg" ON "pay"."withdrawal_approval_events";
CREATE TRIGGER "withdrawal_approval_events_append_only_trg" BEFORE UPDATE OR DELETE ON "pay"."withdrawal_approval_events"
  FOR EACH ROW EXECUTE FUNCTION "pay"."withdrawal_approvals_append_only"();
