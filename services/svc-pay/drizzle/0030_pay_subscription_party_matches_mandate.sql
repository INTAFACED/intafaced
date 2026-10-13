-- svc-pay · a subscription party has to be the mandate's party.
-- Reversal: 0030_pay_subscription_party_matches_mandate.down.sql
--
-- 0010 stores subscriptions.mandate_id, merchant_id, and customer_id apart.
-- mandate_id references subscription_mandates(id) only. merchant_id references
-- merchants(id) only. customer_id is text on both tables and is not compared.
-- subscription_executions reference subscriptions(id) only, so the charge
-- journal follows the subscription's party, not the mandate that authorized
-- the amount. A subscription can name merchant B and customer C2 while its
-- mandate belongs to merchant A and customer C1.
--
-- PostgreSQL requires the referenced columns to be unique. id is already the
-- primary key, so UNIQUE (id, merchant_id, customer_id) does not invent a
-- second key. The foreign key is then (mandate_id, merchant_id, customer_id).
-- The existing mandate_id foreign key stays. Not a trigger and not a check.
-- This file does not rewrite merchant_id or customer_id, does not move value,
-- and does not invent a customer id, a merchant id, or an amount. If a stored
-- subscription already names a different party than its mandate, ADD
-- CONSTRAINT fails and that row stays. 0010 is already applied.

ALTER TABLE "pay"."subscription_mandates"
  ADD CONSTRAINT "subscription_mandates_id_merchant_customer_uq"
  UNIQUE ("id", "merchant_id", "customer_id");

ALTER TABLE "pay"."subscriptions"
  ADD CONSTRAINT "subscriptions_mandate_merchant_customer_fk"
  FOREIGN KEY ("mandate_id", "merchant_id", "customer_id")
  REFERENCES "pay"."subscription_mandates" ("id", "merchant_id", "customer_id");
