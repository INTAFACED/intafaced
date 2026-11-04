-- J-identity-01 #7: the confirmation mail carries a six-digit code beside its link, typed on Account. Stored only as an
-- HMAC under the flow key; wrong codes are counted so the owner's limit can spend the proof.
ALTER TABLE "identity"."email_confirmation_proofs" ADD COLUMN IF NOT EXISTS "pin_hash" text;
ALTER TABLE "identity"."email_confirmation_proofs" ADD COLUMN IF NOT EXISTS "pin_attempts" integer NOT NULL DEFAULT 0;

-- The audit names the code's own outcomes too: confirmed by code, a wrong code, and a code spent at the limit.
ALTER TABLE "identity"."email_confirmation_audit" DROP CONSTRAINT IF EXISTS "email_confirmation_audit_reason_ck";
ALTER TABLE "identity"."email_confirmation_audit" ADD CONSTRAINT "email_confirmation_audit_reason_ck"
  CHECK ("reason" IN ('issued', 'confirmed', 'expired', 'reused', 'mismatch', 'confirmed_code', 'wrong_code', 'code_locked'));
