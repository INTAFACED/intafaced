-- svc-identity · refresh reuse grace
-- Reversal: 0032_session_refresh_grace.down.sql
--
-- A second tab can present the refresh token that the first tab just rotated.
-- The predecessor row keeps the successor id and a sealed copy of the successor
-- refresh token so that presentation can return the already-rotated pair.
-- The raw token is not stored. successor_refresh is AES-256-GCM (enc:v1).
-- Outside the grace window the revoked row is still reuse, and the family burns.

ALTER TABLE "identity"."sessions"
  ADD COLUMN IF NOT EXISTS "rotated_at" timestamptz;

ALTER TABLE "identity"."sessions"
  ADD COLUMN IF NOT EXISTS "successor_id" uuid;

ALTER TABLE "identity"."sessions"
  ADD COLUMN IF NOT EXISTS "successor_refresh" text;
