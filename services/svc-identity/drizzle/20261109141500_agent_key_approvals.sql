-- J-developer-15 #6 (DV-keys-05): a sensitive action an agent key attempts (a payout, a refund) does not run. The edge
-- holds it and identity writes one row here for the key's owner to see; nothing is forwarded to the service. The row
-- names the action and the request (method, path and a hash of the body), never the body itself. The business key
-- (key, action, body hash) makes a retried attempt read back the same row instead of writing a second one.
CREATE TABLE IF NOT EXISTS "identity"."agent_key_approvals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "idempotency_key" text NOT NULL UNIQUE,
  "user_id" uuid NOT NULL,
  "key_id" uuid NOT NULL REFERENCES "identity"."api_keys" ("id"),
  "action" text NOT NULL,
  "method" text NOT NULL,
  "path" text NOT NULL,
  "body_hash" text NOT NULL,
  "status" text NOT NULL DEFAULT 'waiting' CHECK ("status" IN ('waiting')),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "agent_key_approvals_user_created" ON "identity"."agent_key_approvals" ("user_id", "created_at" DESC);
