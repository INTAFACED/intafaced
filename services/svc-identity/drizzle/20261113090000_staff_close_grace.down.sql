-- intafaced:destructive drops grace dates of staff closes not yet final; those accounts read open again.
ALTER TABLE "identity"."users" DROP CONSTRAINT IF EXISTS "users_close_grace_check";
UPDATE "identity"."users" SET "closed_reason" = NULL WHERE "close_grace_until" IS NOT NULL;
ALTER TABLE "identity"."users" DROP COLUMN IF EXISTS "close_grace_until";
