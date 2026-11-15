-- svc-quant · library moderation (J-algo-dev-10, AL-library-03)
-- Reversal: 20261115160000_quant_library_moderation.down.sql
--
-- No money, no balance, no ledger post. Each operator action on a listing (hide, unhide, remove) is one insert-only row
-- naming the actor and the reason, keyed by (listing, seq): the row is the audit row, so the action and its audit can never
-- part. The listing row itself is never rewritten: its state is its newest moderation row. A dispute is one insert-only row
-- with its support ticket reference; its resolution is one more insert-only row, at most one per dispute.

CREATE TABLE IF NOT EXISTS "quant"."library_moderation" (
  "listing_id" text NOT NULL REFERENCES "quant"."library_listings"("id"),
  "seq" integer NOT NULL CHECK ("seq" >= 0),
  "action" text NOT NULL CHECK ("action" IN ('hide', 'unhide', 'remove')),
  "actor" text NOT NULL,
  "reason" text NOT NULL CHECK (char_length("reason") BETWEEN 1 AND 500),
  "at" timestamptz NOT NULL,
  "row_id" bigserial NOT NULL UNIQUE,
  PRIMARY KEY ("listing_id", "seq")
);

CREATE TABLE IF NOT EXISTS "quant"."library_disputes" (
  "id" text PRIMARY KEY,
  "listing_id" text NOT NULL REFERENCES "quant"."library_listings"("id"),
  "seq" integer NOT NULL CHECK ("seq" >= 0),
  "opened_by" text NOT NULL,
  "reason" text NOT NULL CHECK (char_length("reason") BETWEEN 1 AND 500),
  "ticket_ref" text NOT NULL CHECK (char_length("ticket_ref") BETWEEN 1 AND 120),
  "opened_at" timestamptz NOT NULL,
  "row_id" bigserial NOT NULL UNIQUE,
  UNIQUE ("listing_id", "seq")
);

CREATE TABLE IF NOT EXISTS "quant"."library_dispute_resolutions" (
  "dispute_id" text PRIMARY KEY REFERENCES "quant"."library_disputes"("id"),
  "actor" text NOT NULL,
  "reason" text NOT NULL CHECK (char_length("reason") BETWEEN 1 AND 500),
  "at" timestamptz NOT NULL
);

DROP TRIGGER IF EXISTS "library_moderation_insert_only" ON "quant"."library_moderation";
CREATE TRIGGER "library_moderation_insert_only"
  BEFORE UPDATE OR DELETE ON "quant"."library_moderation"
  FOR EACH ROW EXECUTE FUNCTION "quant"."reject_library_rewrite"();

DROP TRIGGER IF EXISTS "library_disputes_insert_only" ON "quant"."library_disputes";
CREATE TRIGGER "library_disputes_insert_only"
  BEFORE UPDATE OR DELETE ON "quant"."library_disputes"
  FOR EACH ROW EXECUTE FUNCTION "quant"."reject_library_rewrite"();

DROP TRIGGER IF EXISTS "library_dispute_resolutions_insert_only" ON "quant"."library_dispute_resolutions";
CREATE TRIGGER "library_dispute_resolutions_insert_only"
  BEFORE UPDATE OR DELETE ON "quant"."library_dispute_resolutions"
  FOR EACH ROW EXECUTE FUNCTION "quant"."reject_library_rewrite"();
