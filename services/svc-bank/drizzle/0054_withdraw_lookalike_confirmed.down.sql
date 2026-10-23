-- intafaced:destructive drops the record of which saved addresses were confirmed as look-alikes; the entries stay
ALTER TABLE "bank"."user_withdraw_destinations" DROP CONSTRAINT IF EXISTS "user_withdraw_destinations_lookalike_ck";
ALTER TABLE "bank"."user_withdraw_destinations" DROP COLUMN IF EXISTS "lookalike_confirmed_at";
ALTER TABLE "bank"."user_withdraw_destinations" DROP COLUMN IF EXISTS "lookalike_of";
