-- Sub-account kind and nickname (I-account-lifecycle-03): the kind of partition and the nickname the owner
-- picked at create. A nickname is 5 to 20 letters or digits, unique per main account (case-insensitive), and
-- never changes. Rows made before this keep a null nickname and the kind `standard`.
-- Reversal: 0060_sub_account_kind_nickname.down.sql

ALTER TABLE "identity"."sub_accounts" ADD COLUMN IF NOT EXISTS "kind" text NOT NULL DEFAULT 'standard'
  CHECK ("kind" IN ('standard', 'managed', 'derivatives', 'spot'));
ALTER TABLE "identity"."sub_accounts" ADD COLUMN IF NOT EXISTS "nickname" text
  CHECK ("nickname" IS NULL OR "nickname" ~ '^[A-Za-z0-9]{5,20}$');

CREATE UNIQUE INDEX IF NOT EXISTS "sub_accounts_parent_nickname_uq"
  ON "identity"."sub_accounts" ("parent_user_id", lower("nickname")) WHERE "nickname" IS NOT NULL;

CREATE OR REPLACE FUNCTION "identity"."sub_accounts_nickname_immutable"() RETURNS trigger AS $$
BEGIN
  IF OLD."nickname" IS NOT NULL AND NEW."nickname" IS DISTINCT FROM OLD."nickname" THEN
    RAISE EXCEPTION 'sub-account nickname is immutable';
  END IF;
  IF NEW."kind" IS DISTINCT FROM OLD."kind" THEN
    RAISE EXCEPTION 'sub-account kind is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "sub_accounts_nickname_immutable" ON "identity"."sub_accounts";
CREATE TRIGGER "sub_accounts_nickname_immutable" BEFORE UPDATE ON "identity"."sub_accounts"
  FOR EACH ROW EXECUTE FUNCTION "identity"."sub_accounts_nickname_immutable"();
