-- M-plat-org-13 (J-merchant-02 #1): the business step's saved draft, kept for the person before their account exists.
-- Reversal: 20261112093218_pay_merchant_onboarding_draft.down.sql
--
-- One row per signed-in person: what they typed on the onboarding business step, so leaving the page, signing out or
-- switching browsers never drops it. It is the person's own words, not an account: nothing here opens a merchant, holds a
-- fee or moves money, and the row is deleted once the account is opened. The fields are the step's own text inputs.

CREATE TABLE IF NOT EXISTS "pay"."merchant_onboarding_drafts" (
  "user_id" uuid PRIMARY KEY,
  "fields" jsonb NOT NULL,
  -- The page's own count of its saves: a save older than the stored one (a late request) never overwrites it.
  "client_seq" bigint NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
