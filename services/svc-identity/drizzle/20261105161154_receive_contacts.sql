-- Receive by email or phone (PP-send-request-03, J-pay-03 #6): a person adds an extra email address or phone number that
-- people can pay them by. It only counts once the person proves they hold it with the six-digit code sent to it.
--
-- One row per address an account added. While unproved, the row holds the SHA-256 of the code, when it stops working
-- and how many wrong tries it has taken; proving it clears the code and stamps verified_at. A proved address belongs to
-- one account only (the partial unique index), so a payment to it can name exactly one person. The cap on addresses per
-- account, the code's life and the wrong tries allowed are owner settings (IDENTITY_RECEIVE_CONTACT_*), never stored
-- here. receive_contact_audit keeps one row per add, code sent, proof and removal; its code_sent rows are the
-- per-account budget on codes sent inside one code life.
--
-- Reversal: 20261105161154_receive_contacts.down.sql

CREATE TABLE IF NOT EXISTS "identity"."receive_contacts" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"          uuid NOT NULL REFERENCES "identity"."users"("id"),
  "channel"          text NOT NULL,
  "target"           citext NOT NULL,
  "code_hash"        text,
  "code_expires_at"  timestamptz,
  "attempts"         integer NOT NULL DEFAULT 0,
  "verified_at"      timestamptz,
  "created_at"       timestamptz NOT NULL DEFAULT now(),
  "updated_at"       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "receive_contacts_channel_ck" CHECK ("channel" IN ('email', 'phone')),
  CONSTRAINT "receive_contacts_attempts_ck" CHECK ("attempts" >= 0),
  CONSTRAINT "receive_contacts_code_ck" CHECK (("code_hash" IS NULL) = ("code_expires_at" IS NULL))
);

-- An account lists an address once; a proved address names one account.
CREATE UNIQUE INDEX IF NOT EXISTS "receive_contacts_user_target_uq" ON "identity"."receive_contacts" ("user_id", "channel", "target");
CREATE UNIQUE INDEX IF NOT EXISTS "receive_contacts_verified_uq" ON "identity"."receive_contacts" ("channel", "target") WHERE "verified_at" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "identity"."receive_contact_audit" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"     uuid NOT NULL REFERENCES "identity"."users"("id"),
  "session_id"  text NOT NULL,
  "channel"     text NOT NULL,
  "event"       text NOT NULL,
  "target"      citext NOT NULL,
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "receive_contact_audit_event_ck" CHECK ("event" IN ('added', 'code_sent', 'verified', 'removed'))
);

CREATE INDEX IF NOT EXISTS "receive_contact_audit_user_idx" ON "identity"."receive_contact_audit" ("user_id", "created_at");
