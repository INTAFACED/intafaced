-- Reverses 20261106092512_idle_signout.sql. Each account's own idle sign-out goes; the owner's setting still applies.
ALTER TABLE "identity"."users" DROP COLUMN IF EXISTS "idle_signout_seconds";
