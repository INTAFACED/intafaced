-- Reverses 0043. Fails closed: a saved book entry has no place in the one-slot-per-kind table, and this does not
-- delete a customer's saved address to make the old key fit.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "bank"."user_withdraw_destinations" WHERE "origin" <> 'legacy') THEN
    RAISE EXCEPTION 'withdraw address book has saved entries; remove them before reversing 0043';
  END IF;
END $$;

DROP INDEX IF EXISTS "bank"."user_withdraw_destinations_label_idx";
DROP INDEX IF EXISTS "bank"."user_withdraw_destinations_book_idx";
DROP INDEX IF EXISTS "bank"."user_withdraw_destinations_legacy_idx";

ALTER TABLE "bank"."user_withdraw_destinations" DROP CONSTRAINT "user_withdraw_destinations_pkey";
CREATE UNIQUE INDEX "user_withdraw_destinations_id_idx" ON "bank"."user_withdraw_destinations" ("destination_id");
ALTER TABLE "bank"."user_withdraw_destinations" ADD CONSTRAINT "user_withdraw_destinations_pkey" PRIMARY KEY ("user_id", "kind");

ALTER TABLE "bank"."user_withdraw_destinations"
  DROP CONSTRAINT IF EXISTS "user_withdraw_destinations_tag_ck",
  DROP CONSTRAINT IF EXISTS "user_withdraw_destinations_book_ck",
  DROP CONSTRAINT IF EXISTS "user_withdraw_destinations_state_ck",
  DROP CONSTRAINT IF EXISTS "user_withdraw_destinations_origin_ck",
  DROP COLUMN IF EXISTS "state",
  DROP COLUMN IF EXISTS "origin",
  DROP COLUMN IF EXISTS "tag",
  DROP COLUMN IF EXISTS "network",
  DROP COLUMN IF EXISTS "asset_id";
