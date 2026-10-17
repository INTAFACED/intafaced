-- intafaced:destructive — reversal of 0034_email_confirmation.sql.
DROP TRIGGER IF EXISTS "users_email_change_consumes_proofs" ON "identity"."users";
DROP TRIGGER IF EXISTS "users_email_change_clears_verification" ON "identity"."users";
DROP FUNCTION IF EXISTS "identity"."consume_email_proofs_on_email_change"();
DROP FUNCTION IF EXISTS "identity"."clear_email_verified_on_email_change"();
DROP TABLE IF EXISTS "identity"."email_confirmation_audit";
DROP TABLE IF EXISTS "identity"."email_confirmation_attempts";
DROP TABLE IF EXISTS "identity"."email_confirmation_proofs";
ALTER TABLE "identity"."users" DROP COLUMN IF EXISTS "email_verified_at";
