-- D-145. A step-up mint of pay:refund / pay:payout is audited. A factor proof
-- lives five minutes. pay:payout may sit on an API key when creation was an
-- explicit step-up, so the interactive-only CHECK no longer names it.
-- trade:withdraw, treasury, card, and desk scopes stay refused.
-- Reversal: 0045_pay_step_up.down.sql. No balances.

ALTER TABLE "identity"."api_keys" DROP CONSTRAINT IF EXISTS "api_keys_no_withdraw_ck";
ALTER TABLE "identity"."api_keys" ADD CONSTRAINT "api_keys_no_withdraw_ck"
  CHECK (NOT ("scopes" && ARRAY['trade:withdraw', 'admin:treasury', 'bank:card', 'admin:read', 'admin:write', 'admin:compliance', 'support:ops', 'market:ops']));

CREATE TABLE IF NOT EXISTS "identity"."pay_step_up_proofs" (
  "proof_id" uuid PRIMARY KEY,
  "user_id" uuid NOT NULL REFERENCES "identity"."users" ("id"),
  "session_id" uuid NOT NULL,
  "method" text NOT NULL CHECK ("method" IN ('totp', 'passkey')),
  "verified_at" timestamptz NOT NULL,
  "expires_at" timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS "identity"."pay_step_up_mints" (
  "audit_id" uuid PRIMARY KEY,
  "user_id" uuid NOT NULL REFERENCES "identity"."users" ("id"),
  "session_id" uuid NOT NULL,
  "merchant_id" uuid NOT NULL,
  "scopes" text[] NOT NULL,
  "factor" text NOT NULL CHECK ("factor" IN ('totp', 'passkey', 'proof')),
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS "pay_step_up_mints_user_idx"
  ON "identity"."pay_step_up_mints" ("user_id", "created_at");
