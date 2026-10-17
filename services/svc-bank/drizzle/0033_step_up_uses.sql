-- Which operation spent a money-out step-up approval (ADR 2026-10-14-money-out-step-up).
--
-- Identity burns an approval on the first consume. When the same transfer/schedule/card
-- request is retried (the first response was lost), bank answers from this row instead of
-- asking identity again; a different operation with the same approval is refused.
-- The session that spent it is kept too, so another session of the same user cannot replay it.
-- One row per approval, written once after identity has consumed it, never updated.
-- Holds ids and a payload hash, no amounts and no balances.
--
-- Reversal: 0033_step_up_uses.down.sql

CREATE TABLE IF NOT EXISTS "bank"."step_up_uses" (
  "approval_id"   text PRIMARY KEY CONSTRAINT "step_up_uses_approval_not_blank" CHECK (length(btrim("approval_id")) > 0),
  "user_id"       text NOT NULL CONSTRAINT "step_up_uses_user_not_blank" CHECK (length(btrim("user_id")) > 0),
  "session_id"    text NOT NULL CONSTRAINT "step_up_uses_session_not_blank" CHECK (length(btrim("session_id")) > 0),
  "action_type"   text NOT NULL,
  "payload_hash"  text NOT NULL,
  "operation_key" text NOT NULL CONSTRAINT "step_up_uses_operation_not_blank" CHECK (length(btrim("operation_key")) > 0),
  "expires_at"    timestamptz NOT NULL,
  "consumed_at"   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "step_up_uses_user_idx" ON "bank"."step_up_uses" ("user_id", "consumed_at");
