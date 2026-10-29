-- MC-token-03 · signed votes (OWNER 108). Every new vote carries the linked wallet that signed it, the signature and the
-- exact message it signed, so a vote can be re-checked. Votes from before this migration keep both null. No amount or rate is touched.
ALTER TABLE "token"."governance_votes"
  ADD COLUMN IF NOT EXISTS "signed_by" text,
  ADD COLUMN IF NOT EXISTS "signature" text,
  ADD COLUMN IF NOT EXISTS "signed_message" text;
ALTER TABLE "token"."governance_votes" DROP CONSTRAINT IF EXISTS "governance_votes_signed_check";
ALTER TABLE "token"."governance_votes"
  ADD CONSTRAINT "governance_votes_signed_check"
  CHECK (
    ("signed_by" IS NULL AND "signature" IS NULL AND "signed_message" IS NULL)
    OR ("signed_by" ~ '^0x[0-9a-f]{40}$' AND "signature" ~ '^0x[0-9a-f]{130}$' AND "signed_message" <> '')
  );
