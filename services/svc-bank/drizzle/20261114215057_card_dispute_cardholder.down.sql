-- Refuses, changing nothing, while any case was withdrawn: the old checks below have no `withdrawn` outcome.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "bank"."card_disputes" WHERE "outcome" = 'withdrawn' OR "decision_requested_outcome" = 'withdrawn') THEN
    RAISE EXCEPTION 'card_dispute_cardholder down: withdrawn cases exist; nothing was changed';
  END IF;
END
$$;

ALTER TABLE "bank"."card_disputes" DROP CONSTRAINT IF EXISTS "card_disputes_outcome_check";
ALTER TABLE "bank"."card_disputes" ADD CONSTRAINT "card_disputes_outcome_check" CHECK ("outcome" IN ('cardholder', 'merchant'));
ALTER TABLE "bank"."card_disputes" DROP CONSTRAINT IF EXISTS "card_disputes_decision_requested_outcome_check";
ALTER TABLE "bank"."card_disputes" ADD CONSTRAINT "card_disputes_decision_requested_outcome_check"
  CHECK ("decision_requested_outcome" IN ('cardholder', 'merchant'));
ALTER TABLE "bank"."card_disputes" DROP COLUMN IF EXISTS "decision_reason";
