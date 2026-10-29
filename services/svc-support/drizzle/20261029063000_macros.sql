-- svc-support · macros and agent signatures (SP-desk-02)
-- Reversal: 20261029063000_macros.down.sql
--
-- A macro is a saved reply with placeholders from a closed list, personal or shared with the desk. `scope_key` is
-- 'shared' or 'personal:<owner>', so a shortcode is unique within its scope in the table itself. Each use is one row,
-- keyed by (ticket, macro, client request id) so a retried apply records nothing twice; usage counts come from it.
-- A signature is the agent's own, one row per person.

CREATE TABLE IF NOT EXISTS "support"."macros" (
  "id" uuid PRIMARY KEY,
  "owner_id" uuid NOT NULL,
  "shared" boolean NOT NULL,
  "scope_key" text NOT NULL,
  "title" text NOT NULL CHECK (char_length("title") BETWEEN 1 AND 120),
  "shortcode" text NOT NULL CHECK ("shortcode" ~ '^[a-z0-9_-]{1,32}$'),
  "body" text NOT NULL CHECK (char_length("body") BETWEEN 1 AND 10000),
  "updated_at" timestamptz NOT NULL,
  CHECK ("scope_key" = CASE WHEN "shared" THEN 'shared' ELSE 'personal:' || lower("owner_id"::text) END),
  UNIQUE ("scope_key", "shortcode")
);

CREATE TABLE IF NOT EXISTS "support"."macro_uses" (
  "macro_id" uuid NOT NULL REFERENCES "support"."macros" ("id"),
  "ticket_id" uuid NOT NULL,
  "used_by" uuid NOT NULL,
  "client_request_id" text NOT NULL CHECK (char_length("client_request_id") BETWEEN 8 AND 200),
  "used_at" timestamptz NOT NULL,
  PRIMARY KEY ("ticket_id", "macro_id", "client_request_id")
);
CREATE INDEX IF NOT EXISTS "macro_uses_macro_idx" ON "support"."macro_uses" ("macro_id");

CREATE TABLE IF NOT EXISTS "support"."staff_signatures" (
  "user_id" uuid PRIMARY KEY,
  "signature" text NOT NULL CHECK (char_length("signature") BETWEEN 1 AND 500),
  "updated_at" timestamptz NOT NULL
);
