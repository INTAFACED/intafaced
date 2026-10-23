-- Customer email switches (M-plat-org-10).
--
-- Which customer emails this merchant wants: receipts, refunds, invoices.
-- A column stays NULL until the merchant sets it. NULL is not off and not on.
-- No address is stored here. Receipt delivery has no provider, so a send is not
-- queued and this table has no send log.

CREATE TABLE IF NOT EXISTS "pay"."merchant_customer_email_settings" (
  "merchant_id"  uuid PRIMARY KEY REFERENCES "pay"."merchants"("id"),
  "receipts"     boolean,
  "refunds"      boolean,
  "invoices"     boolean,
  "updated_by"   text NOT NULL CONSTRAINT "merchant_customer_email_settings_actor_not_blank" CHECK (length(btrim("updated_by")) > 0),
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  "updated_at"   timestamptz NOT NULL DEFAULT now()
);
