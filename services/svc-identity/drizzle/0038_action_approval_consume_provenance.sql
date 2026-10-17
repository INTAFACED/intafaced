-- Who consumed an action approval, and under which client request id.
-- A retry that repeats that request id can be told apart from a different use.
-- Existing rows stay unconsumed: the three columns are null.
-- Also the identity-side trading restriction this approval can apply.
-- Reversal: 0038_action_approval_consume_provenance.down.sql

ALTER TABLE "identity"."action_approvals" ADD COLUMN IF NOT EXISTS "consumed_by_service" text;
ALTER TABLE "identity"."action_approvals" ADD COLUMN IF NOT EXISTS "consumed_by_principal" text;
ALTER TABLE "identity"."action_approvals" ADD COLUMN IF NOT EXISTS "consumed_request_id" text;

ALTER TABLE "identity"."action_approvals" DROP CONSTRAINT IF EXISTS "action_approvals_consume_provenance_ck";
ALTER TABLE "identity"."action_approvals"
  ADD CONSTRAINT "action_approvals_consume_provenance_ck"
  CHECK (
    "consumed_request_id" IS NULL
    OR (
      "status" = 'CONSUMED'
      AND "consumed_by_service" IS NOT NULL
      AND char_length("consumed_by_service") BETWEEN 1 AND 64
      AND char_length("consumed_request_id") BETWEEN 1 AND 128
      AND ("consumed_by_principal" IS NULL OR char_length("consumed_by_principal") BETWEEN 1 AND 128)
    )
  );

CREATE TABLE IF NOT EXISTS "identity"."trading_restrictions" (
  "user_id" uuid PRIMARY KEY REFERENCES "identity"."users" ("id"),
  "restricted" boolean NOT NULL,
  "version" bigint NOT NULL CHECK ("version" >= 0),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
