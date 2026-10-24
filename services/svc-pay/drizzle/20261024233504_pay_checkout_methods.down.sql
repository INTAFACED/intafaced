-- intafaced:destructive — reversal of 20261024233504_pay_checkout_methods.sql
--
-- Drops every business's checkout methods and their save log: every hosted checkout offers the default methods again.

DROP TRIGGER IF EXISTS "checkout_method_saves_kept_trg" ON "pay"."checkout_method_saves";
DROP FUNCTION IF EXISTS "pay"."checkout_method_saves_kept"();
DROP TABLE IF EXISTS "pay"."checkout_method_saves";
DROP TABLE IF EXISTS "pay"."checkout_methods";
