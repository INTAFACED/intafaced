-- intafaced:destructive drops which currencies a customer removed; every removed currency shows on the account again
ALTER TABLE "bank"."spaces" DROP CONSTRAINT IF EXISTS "spaces_removed_primary_only_ck";
ALTER TABLE "bank"."spaces" DROP COLUMN IF EXISTS "removed_at";
