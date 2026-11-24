-- J-bank-15 (BK-cdisp-01): the cardholder disputes a card charge themselves. A case they file may be withdrawn by them,
-- which closes it with the outcome `withdrawn` (any provisional credit is then reversed by the partner, as for a case
-- decided for the merchant), and every decision carries the reason it was made for, which the cardholder reads. The money
-- stays the partner's (OWNER 226): nothing here posts to the ledger.
--
-- Reversal: 20261114215057_card_dispute_cardholder.down.sql

ALTER TABLE "bank"."card_disputes" ADD COLUMN IF NOT EXISTS "decision_reason" text;

ALTER TABLE "bank"."card_disputes" DROP CONSTRAINT IF EXISTS "card_disputes_outcome_check";
ALTER TABLE "bank"."card_disputes" ADD CONSTRAINT "card_disputes_outcome_check"
  CHECK ("outcome" IN ('cardholder', 'merchant', 'withdrawn'));
ALTER TABLE "bank"."card_disputes" DROP CONSTRAINT IF EXISTS "card_disputes_decision_requested_outcome_check";
ALTER TABLE "bank"."card_disputes" ADD CONSTRAINT "card_disputes_decision_requested_outcome_check"
  CHECK ("decision_requested_outcome" IN ('cardholder', 'merchant', 'withdrawn'));
