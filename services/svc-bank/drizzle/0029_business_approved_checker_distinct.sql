-- 0011 lets a business_approvals row be approved with no checker, or with the
-- maker as its own checker. The account comment says spend at or above
-- spend_threshold needs a checker who is not the maker.
--
-- An approved row whose checker is the maker is refused, at any amount. An
-- approved row with no checker is refused when its amount is at or above the
-- account's spend_threshold. An approved row below the threshold with no
-- checker still stores: the service records an under-threshold spend that way
-- (single control, posted at propose). Pending, rejected and cancelled rows
-- are not constrained here; a maker may cancel their own proposal.
--
-- The self-approval CHECK is NOT VALID and the threshold rule is a BEFORE
-- INSERT OR UPDATE trigger (it reads business_accounts), so rows already
-- stored in the old shape do not fail this migration; new inserts and updates
-- are refused (precedent 0024, 0028). This file does not update, delete or
-- insert any row.
--
-- Reversal: 0029_business_approved_checker_distinct.down.sql

ALTER TABLE "bank"."business_approvals" DROP CONSTRAINT IF EXISTS "business_approvals_approved_checker_not_maker";
ALTER TABLE "bank"."business_approvals"
  ADD CONSTRAINT "business_approvals_approved_checker_not_maker"
  CHECK (
    "status" <> 'approved'
    OR "checker_user_id" IS NULL
    OR "checker_user_id" <> "maker_user_id"
  ) NOT VALID;

CREATE OR REPLACE FUNCTION "bank"."business_approvals_over_threshold_checker"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  threshold numeric;
BEGIN
  IF NEW."status" = 'approved' AND NEW."checker_user_id" IS NULL THEN
    SELECT "spend_threshold" INTO threshold
      FROM "bank"."business_accounts"
     WHERE "id" = NEW."account_id";
    IF threshold IS NULL OR NEW."amount" >= threshold THEN
      RAISE EXCEPTION 'business approval % is at or above the spend threshold and needs a checker who is not the maker', NEW."id"
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "business_approvals_over_threshold_checker_trg" ON "bank"."business_approvals";
CREATE TRIGGER "business_approvals_over_threshold_checker_trg"
  BEFORE INSERT OR UPDATE ON "bank"."business_approvals"
  FOR EACH ROW EXECUTE FUNCTION "bank"."business_approvals_over_threshold_checker"();
