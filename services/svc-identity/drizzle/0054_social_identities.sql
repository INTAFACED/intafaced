-- Social sign-in, account side. One provider identity per (provider, subject) and one per
-- account and provider. No provider token is stored. A flow row is a single-use state.
-- password_set is false only for an account that never chose a password, so the last
-- sign-in method can be told apart. Every existing account has one.
-- Reversal: 0054_social_identities.down.sql

ALTER TABLE "identity"."users" ADD COLUMN IF NOT EXISTS "password_set" boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS "identity"."social_identities" (
  "provider" text NOT NULL CHECK ("provider" ~ '^[a-z0-9-]{1,32}$'),
  "subject" text NOT NULL CHECK (char_length("subject") BETWEEN 1 AND 255),
  "user_id" uuid NOT NULL REFERENCES "identity"."users" ("id"),
  "relay_email" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("provider", "subject")
);
CREATE UNIQUE INDEX IF NOT EXISTS "social_identities_user_provider_idx" ON "identity"."social_identities" ("user_id", "provider");

CREATE TABLE IF NOT EXISTS "identity"."social_flows" (
  "state_hash" text PRIMARY KEY CHECK (char_length("state_hash") = 64),
  "provider" text NOT NULL,
  "purpose" text NOT NULL CHECK ("purpose" IN ('signin', 'link')),
  "user_id" uuid REFERENCES "identity"."users" ("id"),
  "expires_at" timestamptz NOT NULL,
  "used_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CHECK (("purpose" = 'link') = ("user_id" IS NOT NULL))
);
