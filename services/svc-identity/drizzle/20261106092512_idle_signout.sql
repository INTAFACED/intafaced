-- A person's own idle sign-out (I-signin-sessions-06, J-identity-06 #4): the most seconds one of their sign-ins may go
-- without a refresh before its next refresh is refused (auth.session_idle). Null: the owner's SESSION_IDLE_SECONDS
-- alone applies. The service never stores a value longer than the owner's or shorter than one access token's life
-- (identity.session_setting_out_of_range); the owner's value is never stored here.
--
-- Reversal: 20261106092512_idle_signout.down.sql
ALTER TABLE "identity"."users"
  ADD COLUMN IF NOT EXISTS "idle_signout_seconds" integer CHECK ("idle_signout_seconds" > 0);

-- When the person last used this sign-in, carried across a refresh the app made with no use since the one before
-- (auth.refresh `idle: true`, the app's timer in an unused tab). Null: last used when this row was written
-- (last_used_at), so a refresh after real use restarts the idle time and a timer alone never does.
ALTER TABLE "identity"."sessions"
  ADD COLUMN IF NOT EXISTS "active_at" timestamptz;
