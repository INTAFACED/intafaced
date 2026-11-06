-- Reverses the session_settings table: customers' idle choices go, and the owner's limit applies to every account.
DROP TABLE IF EXISTS "identity"."session_settings";
