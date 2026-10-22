-- Exposed-key intake (DV-keys-05, keys-012, ENGINE KS-13). One row per operator report, matched or not. No key string,
-- prefix or hash is stored: a matched report names the key id it revoked; a miss names none. `published_at` is the
-- outbox mark for the owner notice event; null means the publish is still owed and is retried on the same report id.
-- Reversal: 0073_api_key_exposure_reports.down.sql

CREATE TABLE IF NOT EXISTS "identity"."api_key_exposure_reports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "actor_id" uuid NOT NULL,
  "client_request_id" text NOT NULL UNIQUE CHECK (char_length("client_request_id") BETWEEN 1 AND 128),
  "key_id" uuid REFERENCES "identity"."api_keys" ("id") ON DELETE SET NULL,
  "user_id" uuid REFERENCES "identity"."users" ("id") ON DELETE SET NULL,
  "reported_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  "published_at" timestamptz
);

CREATE INDEX IF NOT EXISTS "api_key_exposure_reports_unpublished_idx"
  ON "identity"."api_key_exposure_reports" ("reported_at") WHERE "key_id" IS NOT NULL AND "published_at" IS NULL;
