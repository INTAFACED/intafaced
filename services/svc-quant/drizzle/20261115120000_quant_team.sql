-- svc-quant · strategy teams (J-algo-dev-08, AL-team-01)
-- Reversal: the matching .down.sql
--
-- No money, no balance, no ledger post. Who a strategy is shared with and under which permission; the one edit lock per
-- strategy, which lapses at its stored time; the owner's time-boxed grants that let support read the source; and one
-- insert-only audit row for every support read of a strategy, granted or not.

CREATE TABLE IF NOT EXISTS "quant"."strategy_collaborators" (
  "strategy_id" text NOT NULL REFERENCES "quant"."strategies"("id"),
  "owner_id" uuid NOT NULL,
  "member_id" uuid NOT NULL,
  "role" text NOT NULL CHECK ("role" IN ('view', 'edit')),
  "live_control" boolean NOT NULL DEFAULT false,
  "added_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("strategy_id", "member_id"),
  CHECK ("owner_id" <> "member_id")
);

CREATE INDEX IF NOT EXISTS "strategy_collaborators_member_idx" ON "quant"."strategy_collaborators" ("member_id");

CREATE TABLE IF NOT EXISTS "quant"."strategy_edit_locks" (
  "strategy_id" text PRIMARY KEY REFERENCES "quant"."strategies"("id"),
  "holder_id" uuid NOT NULL,
  "taken_at" timestamptz NOT NULL,
  "expires_at" timestamptz NOT NULL,
  CHECK ("expires_at" > "taken_at")
);

CREATE TABLE IF NOT EXISTS "quant"."support_grants" (
  "id" text PRIMARY KEY,
  "strategy_id" text NOT NULL REFERENCES "quant"."strategies"("id"),
  "owner_id" uuid NOT NULL,
  "write_key" text NOT NULL,
  "created_at" timestamptz NOT NULL,
  "expires_at" timestamptz NOT NULL,
  CHECK ("expires_at" > "created_at"),
  UNIQUE ("owner_id", "write_key")
);

CREATE TABLE IF NOT EXISTS "quant"."support_reads" (
  "id" text PRIMARY KEY,
  "strategy_id" text NOT NULL REFERENCES "quant"."strategies"("id"),
  "grant_id" text REFERENCES "quant"."support_grants"("id"),
  "reader" text NOT NULL,
  "granted" boolean NOT NULL,
  "read_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "support_reads_strategy_idx" ON "quant"."support_reads" ("strategy_id", "read_at");

CREATE OR REPLACE FUNCTION "quant"."reject_support_rewrite"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'quant.support_audit_immutable — a support grant and its read rows cannot be rewritten';
END;
$$;

DROP TRIGGER IF EXISTS "support_grants_insert_only" ON "quant"."support_grants";
CREATE TRIGGER "support_grants_insert_only"
  BEFORE UPDATE OR DELETE ON "quant"."support_grants"
  FOR EACH ROW EXECUTE FUNCTION "quant"."reject_support_rewrite"();

DROP TRIGGER IF EXISTS "support_reads_insert_only" ON "quant"."support_reads";
CREATE TRIGGER "support_reads_insert_only"
  BEFORE UPDATE OR DELETE ON "quant"."support_reads"
  FOR EACH ROW EXECUTE FUNCTION "quant"."reject_support_rewrite"();
