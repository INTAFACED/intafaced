-- Named developer sandboxes (DV-sandbox-01, J-developer-02 #2 and #3). A sandbox is a named place for TEST work on one
-- account; its keys are API keys born in the sandbox environment. Creates are idempotent by the client's request id, a
-- business key. A key's environment is fixed at birth: no update may change it, so a sandbox key never becomes live
-- and a live key never becomes a sandbox key.
-- Reversal: 20261029140000_developer_sandboxes.down.sql

CREATE TABLE IF NOT EXISTS "identity"."developer_sandboxes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "identity"."users"("id") ON DELETE CASCADE,
  "name" text NOT NULL CHECK (length("name") BETWEEN 1 AND 40),
  "request_id" text NOT NULL CHECK (length("request_id") BETWEEN 8 AND 200),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("user_id", "request_id")
);

-- A name is unique on the account without regard to case.
CREATE UNIQUE INDEX IF NOT EXISTS "developer_sandboxes_user_lower_name_idx" ON "identity"."developer_sandboxes" ("user_id", lower("name"));

-- Which sandbox a sandbox key belongs to. One sandbox per key.
CREATE TABLE IF NOT EXISTS "identity"."developer_sandbox_keys" (
  "api_key_id" uuid PRIMARY KEY REFERENCES "identity"."api_keys"("id") ON DELETE CASCADE,
  "sandbox_id" uuid NOT NULL REFERENCES "identity"."developer_sandboxes"("id") ON DELETE CASCADE,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "developer_sandbox_keys_sandbox_idx" ON "identity"."developer_sandbox_keys" ("sandbox_id");

CREATE OR REPLACE FUNCTION "identity"."api_keys_mode_immutable"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."mode" IS DISTINCT FROM OLD."mode" THEN
    RAISE EXCEPTION 'an API key''s environment is fixed when it is made' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "api_keys_mode_immutable" ON "identity"."api_keys";
CREATE TRIGGER "api_keys_mode_immutable" BEFORE UPDATE OF "mode" ON "identity"."api_keys"
  FOR EACH ROW EXECUTE FUNCTION "identity"."api_keys_mode_immutable"();
