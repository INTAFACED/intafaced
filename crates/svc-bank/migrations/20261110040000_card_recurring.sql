-- svc-bank · recurring card payments (J-bank-14 #6; BK-cpay-02)
-- Reversal: 20261110040000_card_recurring.down.sql
--
-- recurring: the issuer's message said the merchant charged a card it keeps on file, on a schedule the cardholder agreed
-- (a subscription). It is what the issuer said, never a guess from the merchant's name. Older rows had no such flag and
-- read false. Nothing here is a balance and no value moves.

ALTER TABLE "bank"."card_authorizations" ADD COLUMN IF NOT EXISTS "recurring" boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS "card_authorizations_recurring_idx" ON "bank"."card_authorizations" ("card_id", "decided_at") WHERE "recurring";
