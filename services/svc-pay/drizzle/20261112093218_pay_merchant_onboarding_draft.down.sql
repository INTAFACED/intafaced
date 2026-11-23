-- intafaced:destructive — reversal of 20261112093218_pay_merchant_onboarding_draft.sql
--
-- Drops the onboarding business-step drafts. Only unsent form text is lost; no account, fee or balance changes.

DROP TABLE IF EXISTS "pay"."merchant_onboarding_drafts";
