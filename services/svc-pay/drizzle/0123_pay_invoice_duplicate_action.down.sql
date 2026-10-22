-- The copies stay as ordinary drafts; only their replay records go.
DELETE FROM "pay"."merchant_invoice_actions" WHERE "action" = 'duplicate';
ALTER TABLE "pay"."merchant_invoice_actions" DROP CONSTRAINT "merchant_invoice_actions_action_ck";
ALTER TABLE "pay"."merchant_invoice_actions" ADD CONSTRAINT "merchant_invoice_actions_action_ck"
  CHECK ("action" IN ('create', 'send', 'void', 'mark_paid', 'reissue_link'));
