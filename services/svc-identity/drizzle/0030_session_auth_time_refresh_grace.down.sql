-- intafaced:destructive — reversal of 0030_session_auth_time_refresh_grace.sql; drops the sign-in time and session family on sessions and the short-lived refresh grace rows (transient; no money, no credentials). After it, refresh again carries `mfa` forward without a max age, so roll back the service in the same step.
DROP TABLE IF EXISTS "identity"."session_refresh_grace";
DROP INDEX IF EXISTS "identity"."sessions_family_idx";
ALTER TABLE "identity"."sessions" DROP COLUMN IF EXISTS "family_id";
ALTER TABLE "identity"."sessions" DROP COLUMN IF EXISTS "auth_time";
