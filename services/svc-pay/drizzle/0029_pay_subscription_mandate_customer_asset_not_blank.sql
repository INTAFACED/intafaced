-- svc-pay · a mandate cannot name a blank customer or a blank asset.
-- Reversal: 0029_pay_subscription_mandate_customer_asset_not_blank.down.sql
--
-- 0010 stores subscription_mandates.customer_id and asset_id as text NOT NULL.
-- subscriptions.path already refuses a blank with
-- CHECK (length(btrim(path)) > 0). These two columns do not. NOT NULL still
-- admits '' and a string of spaces. status defaults to active, and amount
-- must be positive, so a mandate can authorize a charge with a blank customer
-- or a blank asset.
--
-- CHECK only. This file does not invent a customer id, an asset id, or an
-- amount default. It does not turn either column into an enum. It leaves the
-- existing amount > 0 check unchanged and does not touch ceiling. If a stored
-- row is already blank, ADD CONSTRAINT fails and that row stays. 0010 is
-- already applied. No value moves.

ALTER TABLE "pay"."subscription_mandates"
  ADD CONSTRAINT "subscription_mandates_customer_id_not_blank"
  CHECK (length(btrim("customer_id")) > 0);

ALTER TABLE "pay"."subscription_mandates"
  ADD CONSTRAINT "subscription_mandates_asset_id_not_blank"
  CHECK (length(btrim("asset_id")) > 0);
