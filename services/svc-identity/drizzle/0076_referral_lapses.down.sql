-- Reverses 0076_referral_lapses.sql. Relationships that lapsed stay ended; the lapse records go.
DROP INDEX IF EXISTS "identity"."affiliate_commission_accruals_payer_idx";
DROP TABLE IF EXISTS "identity"."referral_lapses";
