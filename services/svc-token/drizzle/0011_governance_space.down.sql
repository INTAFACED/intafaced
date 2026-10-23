-- intafaced:destructive — drops the governance space, follows, and proposer settings.
-- Proposal text columns added for MC-token-01 go with them. No balance is rewritten.

DROP TABLE IF EXISTS "token"."governance_follows";
DROP TABLE IF EXISTS "token"."governance_spaces";
DROP TABLE IF EXISTS "token"."governance_proposer";

ALTER TABLE "token"."proposals" DROP COLUMN IF EXISTS "author_id";
ALTER TABLE "token"."proposals" DROP COLUMN IF EXISTS "title";
ALTER TABLE "token"."proposals" DROP COLUMN IF EXISTS "body_md";
ALTER TABLE "token"."proposals" DROP COLUMN IF EXISTS "discussion_link";
ALTER TABLE "token"."proposals" DROP COLUMN IF EXISTS "business_key";
ALTER TABLE "token"."proposals" DROP COLUMN IF EXISTS "request_handle";
ALTER TABLE "token"."proposals" DROP COLUMN IF EXISTS "revision";
ALTER TABLE "token"."proposals" DROP COLUMN IF EXISTS "ordinal";
ALTER TABLE "token"."proposals" DROP COLUMN IF EXISTS "space_id";
