-- svc-quant · the strategy library (J-algo-dev-09, AL-library-01, AL-library-02)
-- Reversal: 20261115140000_quant_library.down.sql
--
-- No money, no balance, no ledger post. A listing is one checked version of a strategy, stored once under its business
-- key (`quant.listing:<strategy>:v<version>`) and never rewritten; `seq` is registration order, the only order the
-- library lists in. Access to an invite-only listing is one insert-only row per request, grant or revoke, naming who
-- wrote it. A clone keeps its lineage to the listing it came from. One review per person per listing.

CREATE TABLE IF NOT EXISTS "quant"."library_listings" (
  "id" text PRIMARY KEY,
  "seq" bigserial NOT NULL UNIQUE,
  "owner_id" uuid NOT NULL,
  "write_key" text NOT NULL,
  "strategy_id" text NOT NULL REFERENCES "quant"."strategies"("id"),
  "strategy_version" integer NOT NULL CHECK ("strategy_version" >= 1),
  "run_id" text NOT NULL,
  "title" text NOT NULL CHECK (char_length("title") BETWEEN 1 AND 120),
  "description" text NOT NULL CHECK (char_length("description") BETWEEN 1 AND 4000),
  "tags" text[] NOT NULL,
  "visibility" text NOT NULL CHECK ("visibility" IN ('open', 'protected', 'invite')),
  "licence" text NOT NULL CHECK (char_length("licence") BETWEEN 1 AND 200),
  "checklist_version" text NOT NULL,
  "listed_at" timestamptz NOT NULL,
  UNIQUE ("owner_id", "write_key")
);

CREATE INDEX IF NOT EXISTS "library_listings_owner_idx" ON "quant"."library_listings" ("owner_id", "seq");

CREATE TABLE IF NOT EXISTS "quant"."library_access" (
  "listing_id" text NOT NULL REFERENCES "quant"."library_listings"("id"),
  "user_id" uuid NOT NULL,
  "action" text NOT NULL CHECK ("action" IN ('request', 'grant', 'revoke')),
  "seq" integer NOT NULL CHECK ("seq" >= 0),
  "actor" uuid NOT NULL,
  "at" timestamptz NOT NULL,
  "row_id" bigserial NOT NULL UNIQUE,
  PRIMARY KEY ("listing_id", "user_id", "action", "seq")
);

CREATE TABLE IF NOT EXISTS "quant"."library_clones" (
  "strategy_id" text PRIMARY KEY REFERENCES "quant"."strategies"("id"),
  "account_id" uuid NOT NULL,
  "listing_id" text NOT NULL REFERENCES "quant"."library_listings"("id"),
  "source_version" integer NOT NULL CHECK ("source_version" >= 1),
  "cloned_at" timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS "library_clones_listing_idx" ON "quant"."library_clones" ("listing_id", "account_id");

CREATE TABLE IF NOT EXISTS "quant"."library_reviews" (
  "listing_id" text NOT NULL REFERENCES "quant"."library_listings"("id"),
  "reviewer_id" uuid NOT NULL,
  "text" text NOT NULL CHECK (char_length("text") BETWEEN 1 AND 2000),
  "created_at" timestamptz NOT NULL,
  PRIMARY KEY ("listing_id", "reviewer_id")
);

CREATE OR REPLACE FUNCTION "quant"."reject_library_rewrite"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'quant.library_immutable — a listing, access row, clone or review cannot be rewritten';
END;
$$;

DROP TRIGGER IF EXISTS "library_listings_insert_only" ON "quant"."library_listings";
CREATE TRIGGER "library_listings_insert_only"
  BEFORE UPDATE OR DELETE ON "quant"."library_listings"
  FOR EACH ROW EXECUTE FUNCTION "quant"."reject_library_rewrite"();

DROP TRIGGER IF EXISTS "library_access_insert_only" ON "quant"."library_access";
CREATE TRIGGER "library_access_insert_only"
  BEFORE UPDATE OR DELETE ON "quant"."library_access"
  FOR EACH ROW EXECUTE FUNCTION "quant"."reject_library_rewrite"();
