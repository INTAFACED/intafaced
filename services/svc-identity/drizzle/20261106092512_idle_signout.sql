-- A person's own idle sign-out (I-signin-sessions-06, J-identity-06 #4): the most seconds one of their sign-ins may go
-- without a refresh before its next refresh is refused (auth.session_idle). Null: the owner's SESSION_IDLE_SECONDS
-- alone applies. The service never stores a value longer than the owner's or shorter than one access token's life
-- (identity.session_setting_out_of_range); the owner's value is never stored here.
--
-- Reversal: 20261106092512_idle_signout.down.sql
ALTER TABLE "identity"."users"
  ADD COLUMN IF NOT EXISTS "idle_signout_seconds" integer CHECK ("idle_signout_seconds" > 0);
