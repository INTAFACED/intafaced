-- intafaced:destructive — reversal of 0134_pay_payment_views.sql
--
-- Drops saved payment-list views. Unmask audit rows in pay.control_audit stay:
-- they are the record that a shopper field was revealed.

DROP TABLE IF EXISTS "pay"."merchant_payment_views";
