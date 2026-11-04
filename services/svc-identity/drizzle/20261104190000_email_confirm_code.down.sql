-- The code's audit rows go with the code; the older reasons stay.
DELETE FROM "identity"."email_confirmation_audit" WHERE "reason" IN ('confirmed_code', 'wrong_code', 'code_locked');
ALTER TABLE "identity"."email_confirmation_audit" DROP CONSTRAINT IF EXISTS "email_confirmation_audit_reason_ck";
ALTER TABLE "identity"."email_confirmation_audit" ADD CONSTRAINT "email_confirmation_audit_reason_ck"
  CHECK ("reason" IN ('issued', 'confirmed', 'expired', 'reused', 'mismatch'));
ALTER TABLE "identity"."email_confirmation_proofs" DROP COLUMN IF EXISTS "pin_attempts";
ALTER TABLE "identity"."email_confirmation_proofs" DROP COLUMN IF EXISTS "pin_hash";
