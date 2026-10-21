-- Reverses 0060_sub_account_kind_nickname.sql. Sub-accounts keep working; they lose kind and nickname.
DROP TRIGGER IF EXISTS "sub_accounts_nickname_immutable" ON "identity"."sub_accounts";
DROP FUNCTION IF EXISTS "identity"."sub_accounts_nickname_immutable"();
DROP INDEX IF EXISTS "identity"."sub_accounts_parent_nickname_uq";
ALTER TABLE "identity"."sub_accounts" DROP COLUMN IF EXISTS "nickname";
ALTER TABLE "identity"."sub_accounts" DROP COLUMN IF EXISTS "kind";
