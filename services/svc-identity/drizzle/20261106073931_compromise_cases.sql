-- "My account is compromised" (I-signin-sessions-28, J-identity-13 #3 to #5). Starting it ends every session and API
-- key and sets the owner's own freeze (account_self_freezes, reason compromise) in the same transaction, and opens one
-- case here. While a case is open, starting again returns it. The checklist's password and sign-in method items are read
-- from security_factor_events after opened_at; the review items are rows here; a stolen-funds report is a note, which
-- moves no money.
-- Reversal: 20261106073931_compromise_cases.down.sql

CREATE TABLE IF NOT EXISTS "identity"."compromise_cases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "identity"."users" ("id") ON DELETE CASCADE,
  "state" text NOT NULL DEFAULT 'open' CHECK ("state" IN ('open', 'closed')),
  "freeze_id" uuid REFERENCES "identity"."account_self_freezes" ("id"),
  "sessions_ended" integer NOT NULL CHECK ("sessions_ended" >= 0),
  "keys_ended" integer NOT NULL CHECK ("keys_ended" >= 0),
  "opened_at" timestamptz NOT NULL DEFAULT now(),
  "closed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "compromise_cases_one_open_uq"
  ON "identity"."compromise_cases" ("user_id") WHERE "state" = 'open';
CREATE INDEX IF NOT EXISTS "compromise_cases_user_idx" ON "identity"."compromise_cases" ("user_id", "opened_at" DESC);

CREATE TABLE IF NOT EXISTS "identity"."compromise_case_reviews" (
  "case_id" uuid NOT NULL REFERENCES "identity"."compromise_cases" ("id") ON DELETE CASCADE,
  "item" text NOT NULL CHECK ("item" IN ('devices', 'addresses')),
  "reviewed_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("case_id", "item")
);

CREATE TABLE IF NOT EXISTS "identity"."compromise_case_notes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "case_id" uuid NOT NULL REFERENCES "identity"."compromise_cases" ("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "identity"."users" ("id") ON DELETE CASCADE,
  "kind" text NOT NULL CHECK ("kind" IN ('stolen_funds')),
  "body" text NOT NULL CHECK (char_length("body") BETWEEN 1 AND 4000),
  "client_request_id" text NOT NULL CHECK (char_length("client_request_id") BETWEEN 8 AND 100),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("case_id", "client_request_id")
);
