-- Earn rate history (BK-earn-05, J-bank-08 #1): every rate a pool has published, append-only.
--
-- A pool carries one current `apr_bps`. Nothing recorded a change, so a customer could not see how a rate had moved
-- or what was in force when a position opened. From here a pool's rate is written in exactly two places, both in one
-- transaction with this table: opening the pool records its first rate, and an approved change (`ops.setPoolRate`)
-- records the new one. A pool opened before this migration has no record until its first change: no history is
-- invented for it, and the page says there is no earlier history.
--
-- `approval_id` is the identity approval a change consumed, so one approval writes at most one row; the opening record
-- has none. A row is never edited or deleted. Emptying the table in a test fixture fires no row trigger.
--
-- Reversal: 20261024230833_earn_rate_changes.down.sql (refuses while any change is recorded).

CREATE TABLE IF NOT EXISTS "bank"."earn_rate_changes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "pool_id" uuid NOT NULL REFERENCES "bank"."earn_pools" ("id"),
  "rate_bps" integer NOT NULL,
  "effective_at" timestamptz NOT NULL,
  "reason" text,
  "approval_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "earn_rate_changes_rate_ck" CHECK ("rate_bps" >= 0),
  CONSTRAINT "earn_rate_changes_reason_ck" CHECK ("reason" IS NULL OR char_length(btrim("reason")) BETWEEN 3 AND 300)
);
CREATE UNIQUE INDEX IF NOT EXISTS "earn_rate_changes_pool_effective_uq" ON "bank"."earn_rate_changes" ("pool_id", "effective_at");
CREATE UNIQUE INDEX IF NOT EXISTS "earn_rate_changes_approval_uq" ON "bank"."earn_rate_changes" ("approval_id")
  WHERE "approval_id" IS NOT NULL;

CREATE OR REPLACE FUNCTION "bank"."earn_rate_changes_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'earn_rate_changes row % is append-only: record a new change instead', OLD."id"
    USING ERRCODE = '23514';
END;
$$;

CREATE OR REPLACE TRIGGER "earn_rate_changes_append_only_trg"
  BEFORE UPDATE OR DELETE ON "bank"."earn_rate_changes"
  FOR EACH ROW EXECUTE FUNCTION "bank"."earn_rate_changes_append_only"();
