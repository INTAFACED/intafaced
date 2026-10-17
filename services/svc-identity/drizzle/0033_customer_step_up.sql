-- Customer step-up ceremony (stepUp.begin / stepUp.complete).
--
-- A pending row is the intent the user is confirming: user, session, scope,
-- amount and target, and the payload hash the consuming service will recompute.
-- Completing it mints one action approval. The approval itself stays on
-- identity.action_approvals (single-use compare-and-swap). This table is the
-- ceremony and the audit, not a second approval store.
--
-- Reversal: 0033_customer_step_up.down.sql. No balances.

CREATE TABLE IF NOT EXISTS "identity"."customer_step_ups" (
  "challenge_id"        uuid PRIMARY KEY,
  "user_id"             uuid NOT NULL REFERENCES "identity"."users"(id) ON DELETE CASCADE,
  "session_id"          text NOT NULL,
  "scope"               text NOT NULL,
  "purpose"             text NOT NULL,
  "amount"              text,
  "target"              text,
  "payload_hash"        text NOT NULL,
  "webauthn_challenge"  text,
  "status"              text NOT NULL,
  "approval_id"         text,
  "created_at"          timestamptz NOT NULL,
  "expires_at"          timestamptz NOT NULL,
  "minted_at"           timestamptz,
  CONSTRAINT "customer_step_ups_status_ck"
    CHECK ("status" IN ('pending', 'minted', 'expired')),
  CONSTRAINT "customer_step_ups_hash_ck"
    CHECK ("payload_hash" ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT "customer_step_ups_mint_ck"
    CHECK (
      ("status" = 'pending' AND "approval_id" IS NULL AND "minted_at" IS NULL)
      OR ("status" = 'minted' AND "approval_id" IS NOT NULL AND "minted_at" IS NOT NULL)
      OR ("status" = 'expired' AND "approval_id" IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS "customer_step_ups_user_created_idx"
  ON "identity"."customer_step_ups" ("user_id", "created_at");

CREATE UNIQUE INDEX IF NOT EXISTS "customer_step_ups_approval_uidx"
  ON "identity"."customer_step_ups" ("approval_id")
  WHERE "approval_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "customer_step_ups_webauthn_uidx"
  ON "identity"."customer_step_ups" ("webauthn_challenge")
  WHERE "webauthn_challenge" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "identity"."step_up_audit" (
  "audit_id"      uuid PRIMARY KEY,
  "event"         text NOT NULL,
  "challenge_id"  uuid,
  "approval_id"   text,
  "user_id"       uuid NOT NULL,
  "session_id"    text NOT NULL,
  "scope"         text NOT NULL,
  "purpose"       text NOT NULL,
  "amount"        text,
  "target"        text,
  "created_at"    timestamptz NOT NULL,
  CONSTRAINT "step_up_audit_event_ck" CHECK ("event" IN ('minted', 'consumed'))
);

CREATE INDEX IF NOT EXISTS "step_up_audit_approval_idx"
  ON "identity"."step_up_audit" ("approval_id", "created_at");
