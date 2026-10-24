-- svc-identity · recovery keys (RC-identity-07, J-identity-05 #7). The keys an account owner gives to people they trust,
-- so that after a confirmed death notice those people, and never staff, can claim the trading balances for the one heir
-- account the owner named. Only a SHA-256 fingerprint of each key's public half is stored, never key material.
-- `recovery_plans` holds the owner's heir and how many keys must sign a claim; `recovery_keys` holds the keys. A key is
-- unique per account by fingerprint, so adding it twice is one row, and a revoked key cannot be added again.
-- Reversal: the .down.sql of the same name.
CREATE TABLE IF NOT EXISTS "identity"."recovery_plans" (
  "user_id" uuid PRIMARY KEY REFERENCES "identity"."users" ("id") ON DELETE CASCADE,
  "heir_user_id" uuid REFERENCES "identity"."users" ("id"),
  "threshold" integer CHECK ("threshold" >= 1),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "recovery_plans_heir_not_self" CHECK ("heir_user_id" IS NULL OR "heir_user_id" <> "user_id")
);

CREATE TABLE IF NOT EXISTS "identity"."recovery_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "identity"."users" ("id") ON DELETE CASCADE,
  "kind" text NOT NULL CHECK ("kind" IN ('passkey', 'key', 'guardian')),
  "public_material_hash" text NOT NULL CHECK ("public_material_hash" ~ '^[0-9a-f]{64}$'),
  "label" text NOT NULL CHECK (char_length("label") BETWEEN 1 AND 64),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "revoked_at" timestamptz,
  CONSTRAINT "recovery_keys_user_material_key" UNIQUE ("user_id", "public_material_hash")
);
CREATE INDEX IF NOT EXISTS "recovery_keys_live_idx" ON "identity"."recovery_keys" ("user_id") WHERE "revoked_at" IS NULL;
