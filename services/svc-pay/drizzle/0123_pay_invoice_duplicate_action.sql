-- M-bill-07 (billing-tax-028): a draft can be duplicated into a new draft.
-- The action log records it so a replayed request id returns the same copy.
ALTER TABLE "pay"."merchant_invoice_actions" DROP CONSTRAINT "merchant_invoice_actions_action_ck";
ALTER TABLE "pay"."merchant_invoice_actions" ADD CONSTRAINT "merchant_invoice_actions_action_ck"
  CHECK ("action" IN ('create', 'send', 'void', 'mark_paid', 'reissue_link', 'duplicate'));
