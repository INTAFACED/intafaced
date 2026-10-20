-- Reverses 0059_oauth_provider.sql. Apps, codes and tokens are dropped: a token issued by this provider stops
-- working, and the apps register again.
DROP TABLE IF EXISTS "identity"."oauth_tokens";
DROP TABLE IF EXISTS "identity"."oauth_codes";
DROP TABLE IF EXISTS "identity"."oauth_apps";
