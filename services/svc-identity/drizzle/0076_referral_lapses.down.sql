-- Reverses 0076_referral_lapses.sql. Relationships that lapsed stay ended; the lapse records and activity times go.
DROP TABLE IF EXISTS "identity"."referral_lapses";
DROP TABLE IF EXISTS "identity"."referral_activity";
