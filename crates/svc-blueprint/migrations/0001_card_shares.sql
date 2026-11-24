-- svc-blueprint · one share per card, and who opened it (MC-blueprint-01)
-- Reversal: 0001_card_shares.down.sql
--
-- A share is not a visibility flag. Revoking it stops the next read at once.
-- The viewer id is stored so erase can find the row. It is not returned.

CREATE TABLE IF NOT EXISTS "blueprint"."card_shares" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "owner_user_id"  uuid NOT NULL,
  "size"           text NOT NULL,
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  "revoked_at"     timestamptz,
  CONSTRAINT "card_shares_size_chk" CHECK ("size" IN ('portrait', 'landscape'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "card_shares_owner_size_active_idx"
  ON "blueprint"."card_shares" ("owner_user_id", "size")
  WHERE "revoked_at" IS NULL;

CREATE INDEX IF NOT EXISTS "card_shares_owner_idx"
  ON "blueprint"."card_shares" ("owner_user_id", "created_at" DESC);

CREATE TABLE IF NOT EXISTS "blueprint"."card_opens" (
  "share_id"        uuid NOT NULL REFERENCES "blueprint"."card_shares" ("id") ON DELETE CASCADE,
  "viewer_user_id"  uuid NOT NULL,
  "first_opened"    timestamptz NOT NULL DEFAULT now(),
  "last_opened"     timestamptz NOT NULL DEFAULT now(),
  "open_count"      integer NOT NULL DEFAULT 1,
  CONSTRAINT "card_opens_pk" PRIMARY KEY ("share_id", "viewer_user_id"),
  CONSTRAINT "card_opens_count_chk" CHECK ("open_count" >= 1)
);

CREATE INDEX IF NOT EXISTS "card_opens_viewer_idx"
  ON "blueprint"."card_opens" ("viewer_user_id");
