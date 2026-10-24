-- intafaced:destructive — reversal of 20261024192918_pay_checkout_branding.sql
--
-- Drops every business's checkout look and its save log: every hosted checkout shows the default look again.

DROP TRIGGER IF EXISTS "checkout_branding_saves_kept_trg" ON "pay"."checkout_branding_saves";
DROP FUNCTION IF EXISTS "pay"."checkout_branding_saves_kept"();
DROP TABLE IF EXISTS "pay"."checkout_branding_saves";
DROP TABLE IF EXISTS "pay"."checkout_branding";
