-- Our own OAuth provider (DV-oauth-01): registered apps, single-use authorisation codes and the tokens a
-- code exchange issues. A client secret, a code and a token are kept only as sha256 hashes. The code
-- challenge is cleared the moment a code is used, so a code gets one attempt.
-- Reversal: 0059_oauth_provider.down.sql

CREATE TABLE IF NOT EXISTS "identity"."oauth_apps" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "client_id" text NOT NULL UNIQUE CHECK (char_length("client_id") BETWEEN 8 AND 100),
  "developer_user_id" uuid NOT NULL REFERENCES "identity"."users" ("id"),
  "name" text NOT NULL CHECK (char_length("name") BETWEEN 2 AND 80),
  "name_key" text NOT NULL,
  "description" text CHECK ("description" IS NULL OR char_length("description") <= 500),
  "logo_url" text,
  "redirect_urls" text[] NOT NULL CHECK (cardinality("redirect_urls") BETWEEN 1 AND 10),
  "scopes" text[] NOT NULL CHECK (cardinality("scopes") >= 1),
  "confidential" boolean NOT NULL,
  "secret_hash" text CHECK ("secret_hash" IS NULL OR char_length("secret_hash") = 64),
  "secret_rolled_at" timestamptz,
  "last_roll_request_id" text,
  "status" text NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending', 'approved', 'suspended')),
  "request_id" text NOT NULL CHECK (char_length("request_id") BETWEEN 1 AND 200),
  "fingerprint" text NOT NULL CHECK (char_length("fingerprint") = 64),
  "reviewed_by" uuid REFERENCES "identity"."users" ("id"),
  "reviewed_at" timestamptz,
  "review_reason" text CHECK ("review_reason" IS NULL OR char_length("review_reason") <= 500),
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ("confidential" = ("secret_hash" IS NOT NULL)),
  UNIQUE ("developer_user_id", "request_id"),
  UNIQUE ("developer_user_id", "name_key")
);

CREATE INDEX IF NOT EXISTS "oauth_apps_status_idx" ON "identity"."oauth_apps" ("status", "created_at");

CREATE TABLE IF NOT EXISTS "identity"."oauth_codes" (
  "code_hash" text PRIMARY KEY CHECK (char_length("code_hash") = 64),
  "app_id" uuid NOT NULL REFERENCES "identity"."oauth_apps" ("id"),
  "user_id" uuid NOT NULL REFERENCES "identity"."users" ("id"),
  "redirect_url" text NOT NULL,
  "scopes" text[] NOT NULL CHECK (cardinality("scopes") >= 1),
  "code_challenge" text,
  "expires_at" timestamptz NOT NULL,
  "used_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (("used_at" IS NULL) = ("code_challenge" IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS "identity"."oauth_tokens" (
  "token_hash" text PRIMARY KEY CHECK (char_length("token_hash") = 64),
  "app_id" uuid NOT NULL REFERENCES "identity"."oauth_apps" ("id"),
  "user_id" uuid NOT NULL REFERENCES "identity"."users" ("id"),
  "code_hash" text NOT NULL REFERENCES "identity"."oauth_codes" ("code_hash"),
  "scopes" text[] NOT NULL CHECK (cardinality("scopes") >= 1),
  "expires_at" timestamptz NOT NULL,
  "revoked_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS "oauth_tokens_code_idx" ON "identity"."oauth_tokens" ("code_hash");
