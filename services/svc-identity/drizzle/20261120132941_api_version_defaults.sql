-- The account default API version (DV-versioning-01, J-developer-16 #5): the dated version an API-key call that sends no
-- `intafaced-version` header takes (svc-edge reads it from the key exchange). No row means not set, and such a call is
-- refused `version.unset`; nothing defaults to the latest. The service accepts only a version the API implements
-- (`API_VERSIONS` in packages/contracts/src/api-versions.ts); the check here only keeps the column a dated value.
-- Reversal: the .down.sql of the same name.
CREATE TABLE IF NOT EXISTS "identity"."api_version_defaults" (
  "user_id" uuid PRIMARY KEY REFERENCES "identity"."users" ("id") ON DELETE CASCADE,
  "version" text NOT NULL CHECK ("version" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
