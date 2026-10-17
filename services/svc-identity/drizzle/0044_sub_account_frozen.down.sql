ALTER TABLE "identity"."sub_accounts" DROP CONSTRAINT IF EXISTS "sub_accounts_frozen_ck";
ALTER TABLE "identity"."sub_accounts" DROP COLUMN IF EXISTS "frozen";
