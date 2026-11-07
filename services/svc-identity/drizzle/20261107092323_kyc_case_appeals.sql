-- svc-identity · appeals on a rejected verification case (I-kyc-compliance-02, J-identity-20 #8). The customer may appeal a
-- rejection once, within the owner's window after the decision (IDENTITY_KYC_APPEAL_WINDOW_SECONDS; unset = appeals are
-- closed). A reviewer other than the one who rejected decides it: upholding makes the rejection final, so a later appeal
-- refuses kyc.case_final; overturning sends the request back to the review queue.
-- Reversal: the matching .down.sql
ALTER TABLE "identity"."kyc_cases" ADD COLUMN IF NOT EXISTS "final" boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "identity"."kyc_case_appeals" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "case_id"      uuid NOT NULL REFERENCES "identity"."kyc_cases" ("id") ON DELETE CASCADE,
  -- The case version the appeal is about (the rejection), so one rejection takes one appeal.
  "case_version" integer NOT NULL CHECK ("case_version" >= 1),
  "user_id"      uuid NOT NULL,
  "body"         text NOT NULL CHECK (char_length("body") BETWEEN 1 AND 2000),
  "submitted_at" timestamptz NOT NULL DEFAULT now(),
  "decision"     text CHECK ("decision" IS NULL OR "decision" IN ('upheld', 'overturned')),
  "decided_by"   text,
  "decided_at"   timestamptz,
  CONSTRAINT "kyc_case_appeals_once_key" UNIQUE ("case_id", "case_version")
);
