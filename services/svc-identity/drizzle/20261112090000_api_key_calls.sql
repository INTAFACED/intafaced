-- J-developer-08 (DV-keys-06): a key's call log. The edge reports each call it answered for an API key; one row per
-- call, keyed by the edge's request id so a repeated report writes nothing new. A row names what was called (method and
-- path, no query) and the status the edge answered, and whether the caller was outside the key's IP list. Never a body,
-- a header value, the key or the caller's address.
CREATE TABLE IF NOT EXISTS "identity"."api_key_calls" (
  "request_id" text PRIMARY KEY,
  "key_id" uuid NOT NULL REFERENCES "identity"."api_keys" ("id") ON DELETE CASCADE,
  "method" text NOT NULL,
  "path" text NOT NULL,
  "status" integer NOT NULL CHECK ("status" BETWEEN 100 AND 599),
  "outside_ip_list" boolean NOT NULL,
  "called_at" timestamptz NOT NULL,
  "recorded_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "api_key_calls_key_called" ON "identity"."api_key_calls" ("key_id", "called_at" DESC);
