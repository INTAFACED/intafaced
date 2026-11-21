-- svc-agents · user spend limits and reservations (AG-spend-01)
-- Reversal: 0004_user_spend_limits.down.sql
--
-- The user names every cap. A missing row is not a zero cap and not an
-- unlimited cap. Reservations are holds against those caps, not ledger
-- balances: value still moves only when usage settles through feeCharge.

CREATE TABLE IF NOT EXISTS "agents"."user_spend_limits" (
  "user_id"      text PRIMARY KEY,
  "asset_id"     text NOT NULL,
  "per_call"     numeric(38, 18) NOT NULL,
  "per_session"  numeric(38, 18) NOT NULL,
  "per_period"   numeric(38, 18) NOT NULL,
  "period"       text NOT NULL,
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  "updated_at"   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "user_spend_limits_period_ck" CHECK ("period" IN ('day', 'week', 'month')),
  CONSTRAINT "user_spend_limits_nonnegative_ck" CHECK ("per_call" >= 0 AND "per_session" >= 0 AND "per_period" >= 0)
);

CREATE TABLE IF NOT EXISTS "agents"."spend_limit_requests" (
  "user_id"          text NOT NULL,
  "idempotency_key"  text NOT NULL,
  "digest"           text NOT NULL,
  "created_at"       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "idempotency_key")
);

CREATE TABLE IF NOT EXISTS "agents"."spend_reservations" (
  "user_id"           text NOT NULL,
  "reservation_key"   text NOT NULL,
  "session_id"        uuid NOT NULL REFERENCES "agents"."agent_sessions" ("id"),
  "asset_id"          text NOT NULL,
  "amount"            numeric(38, 18) NOT NULL,
  "committed_amount"  numeric(38, 18),
  "status"            text NOT NULL,
  "created_at"        timestamptz NOT NULL DEFAULT now(),
  "updated_at"        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "reservation_key"),
  CONSTRAINT "spend_reservations_status_ck" CHECK ("status" IN ('held', 'committed', 'released')),
  CONSTRAINT "spend_reservations_amount_ck" CHECK ("amount" >= 0),
  CONSTRAINT "spend_reservations_committed_ck" CHECK (
    ("status" = 'committed' AND "committed_amount" IS NOT NULL AND "committed_amount" >= 0 AND "committed_amount" <= "amount")
    OR ("status" <> 'committed' AND "committed_amount" IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS "spend_reservations_session_idx"
  ON "agents"."spend_reservations" ("user_id", "session_id");

CREATE INDEX IF NOT EXISTS "spend_reservations_period_idx"
  ON "agents"."spend_reservations" ("user_id", "created_at");
