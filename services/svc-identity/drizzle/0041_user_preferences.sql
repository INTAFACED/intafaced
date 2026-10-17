-- The caller's own preferences. trade.views is the only namespace the
-- service accepts. version is compare-and-set. The receipt makes a replay
-- of the same client id return the first result.
-- Reversal: 0041_user_preferences.down.sql

CREATE TABLE IF NOT EXISTS "identity"."user_preferences" (
  "user_id" uuid NOT NULL REFERENCES "identity"."users" ("id"),
  "namespace" text NOT NULL CHECK ("namespace" = 'trade.views'),
  "value" jsonb NOT NULL,
  "version" bigint NOT NULL CHECK ("version" >= 1),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "namespace")
);

CREATE TABLE IF NOT EXISTS "identity"."user_preference_receipts" (
  "user_id" uuid NOT NULL REFERENCES "identity"."users" ("id"),
  "client_request_id" text NOT NULL CHECK (char_length("client_request_id") BETWEEN 1 AND 200),
  "fingerprint" text NOT NULL CHECK (char_length("fingerprint") = 64),
  "result" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY ("user_id", "client_request_id")
);
