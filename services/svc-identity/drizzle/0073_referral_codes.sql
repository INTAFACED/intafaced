-- A short referral code per person (CM-referral-01, J-campaigns-05 #1), kept beside the share link token. Random from an
-- unambiguous alphabet, its length an owner setting (IDENTITY_REFERRAL_CODE_LENGTH); one code per person, never reused.
-- Reversal: 0073_referral_codes.down.sql

CREATE TABLE IF NOT EXISTS "identity"."referral_codes" (
  "user_id" uuid PRIMARY KEY REFERENCES "identity"."users"("id") ON DELETE CASCADE,
  "code" text NOT NULL UNIQUE CHECK ("code" ~ '^[A-HJ-NP-Z2-9]{4,16}$'),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
