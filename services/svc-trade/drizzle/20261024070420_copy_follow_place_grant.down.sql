-- intafaced:destructive — reversal of 20261024070420_copy_follow_place_grant.sql
ALTER TABLE "trade"."copy_follows"
  DROP COLUMN IF EXISTS "copy_cursor_fill",
  DROP COLUMN IF EXISTS "copy_cursor_at",
  DROP COLUMN IF EXISTS "session_key_revoked",
  DROP COLUMN IF EXISTS "session_key_prefix",
  DROP COLUMN IF EXISTS "session_key_hash",
  DROP COLUMN IF EXISTS "place_grant";
