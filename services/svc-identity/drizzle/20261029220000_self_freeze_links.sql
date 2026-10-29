-- The freeze link every security notice mail carries (I-account-lifecycle-08, J-identity-11 #2): "this was not me".
-- A link holds only the SHA-256 of its token. Its first use freezes the account (the same freeze as auth.selfFreeze) and
-- stores what it did, so a second use shows that stored result and changes nothing.
-- Reversal: 20261029220000_self_freeze_links.down.sql

CREATE TABLE IF NOT EXISTS "identity"."self_freeze_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "identity"."users" ("id") ON DELETE CASCADE,
  "token_hash" text NOT NULL,
  -- SHA-256 of the address the notice went to. The link works only while that is still the account's address, so a
  -- mailbox the owner has moved away from cannot freeze the account.
  "email_hash" text NOT NULL,
  "purpose" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "used_at" timestamptz,
  "freeze_id" uuid REFERENCES "identity"."account_self_freezes" ("id") ON DELETE SET NULL,
  "frozen_since" timestamptz,
  CONSTRAINT "self_freeze_links_used_ck" CHECK (("used_at" IS NULL) = ("frozen_since" IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS "self_freeze_links_token_uq" ON "identity"."self_freeze_links" ("token_hash");
CREATE INDEX IF NOT EXISTS "self_freeze_links_user_idx" ON "identity"."self_freeze_links" ("user_id", "created_at" DESC);
