-- Audit of API-key actions that needed a fresh second factor, and single-use proofs for them.
-- The accepted factor kind is recorded; no secret and no key material is stored.
-- A proof row issued for one of these actions is bound to that action (and key) and is consumed
-- once. Existing pay proofs keep bound_action NULL and are never accepted for these actions.
-- Reversal: 0047_api_key_action_audit.down.sql.

ALTER TABLE "identity"."pay_step_up_proofs" ADD COLUMN IF NOT EXISTS "bound_action" text;
ALTER TABLE "identity"."pay_step_up_proofs" ADD COLUMN IF NOT EXISTS "bound_key_id" uuid;
ALTER TABLE "identity"."pay_step_up_proofs" ADD COLUMN IF NOT EXISTS "consumed_at" timestamptz;

CREATE TABLE IF NOT EXISTS "identity"."api_key_action_audit" (
  "audit_id" uuid PRIMARY KEY,
  "user_id" uuid NOT NULL REFERENCES "identity"."users" ("id"),
  "session_id" uuid NOT NULL,
  "action" text NOT NULL,
  "key_id" uuid,
  "scopes" text[] NOT NULL DEFAULT '{}',
  "factor" text NOT NULL CHECK ("factor" IN ('totp', 'passkey', 'proof')),
  "proof_id" uuid,
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- One proof, one audited action.
CREATE UNIQUE INDEX IF NOT EXISTS "api_key_action_audit_proof_uidx"
  ON "identity"."api_key_action_audit" ("proof_id") WHERE "proof_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "api_key_action_audit_user_idx"
  ON "identity"."api_key_action_audit" ("user_id", "created_at");
