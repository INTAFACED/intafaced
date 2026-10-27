-- trade.copy · the follower's place grant for the copy driver (CB-copy-10, J-copy-bots-otc-01 #8)
-- Reversal: 20261024070420_copy_follow_place_grant.down.sql
--
-- place_grant: the claims the follower presented at Start copying (scopes, session, tier, second factor), so the
-- copy driver can place each copied order as them until the envelope expires. The same shape the algo engine keeps
-- for its children (algo/durable-principal.ts). Never a token or a secret. NULL on follows made before this column:
-- the driver skips them, so they copy only by hand. Written when the follower grants automatic copying.
--
-- session_key_hash / _prefix / _revoked: the automatic-copying session key, until now held only in process memory,
-- so a restart forgot every grant. The hash only, never the key.
--
-- copy_cursor_at / _fill: the last leader fill the driver dealt with (copied or refused), or the moment copying was
-- turned on. The driver reads only the leader's fills after it, so each fill is tried once and nothing from before
-- copying was on is copied.
ALTER TABLE "trade"."copy_follows"
  ADD COLUMN IF NOT EXISTS "place_grant" jsonb,
  ADD COLUMN IF NOT EXISTS "session_key_hash" text,
  ADD COLUMN IF NOT EXISTS "session_key_prefix" text,
  ADD COLUMN IF NOT EXISTS "session_key_revoked" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "copy_cursor_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "copy_cursor_fill" text;
