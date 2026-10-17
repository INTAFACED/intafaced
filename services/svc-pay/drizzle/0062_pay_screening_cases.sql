-- Screening case for one custodial send (payout or withdrawal).
-- Reversal: 0062_pay_screening_cases.down.sql
--
-- The row stores a status of clear, review, refuse, or unavailable, plus a
-- factor-code list. It does not store a name, a registration number, a wallet
-- address, or sanctions-list contents. subject_key is a hash.

CREATE TABLE IF NOT EXISTS "pay"."screening_cases" (
  "subject_kind" text NOT NULL,
  "subject_key" text NOT NULL,
  "status" text NOT NULL,
  "factors" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "screening_cases_pkey" PRIMARY KEY ("subject_kind", "subject_key"),
  CONSTRAINT "screening_cases_kind_ck" CHECK ("subject_kind" IN ('payout', 'withdrawal')),
  CONSTRAINT "screening_cases_status_ck" CHECK ("status" IN ('clear', 'review', 'refuse', 'unavailable')),
  CONSTRAINT "screening_cases_key_ck" CHECK ("subject_key" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "screening_cases_factors_ck" CHECK (jsonb_typeof("factors") = 'array')
);
