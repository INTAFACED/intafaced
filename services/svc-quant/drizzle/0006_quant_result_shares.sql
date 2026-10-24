-- svc-quant · share a backtest result by link (AL-report-03)
-- Reversal: 0006_quant_result_shares.down.sql
--
-- No money, no balance, no ledger post. A link stores the hash of a secret token, never the token.
-- One run has one active link. Revoking sets revoked_at; the row and its key stay, so the key is not reused.
-- share_reads counts public reads inside the owner's window and holds no account id and no token.

CREATE TABLE IF NOT EXISTS "quant"."result_shares" (
  "account_id"   uuid NOT NULL,
  "run_id"       text NOT NULL REFERENCES "quant"."runs"("id"),
  "seq"          integer NOT NULL,
  "write_key"    text NOT NULL,
  "token_hash"   text NOT NULL,
  "created_at"   timestamptz NOT NULL,
  "revoked_at"   timestamptz,
  PRIMARY KEY ("account_id", "write_key"),
  CONSTRAINT "result_shares_seq_ck" CHECK ("seq" >= 0),
  CONSTRAINT "result_shares_key_ck" CHECK (char_length("write_key") BETWEEN 1 AND 200),
  CONSTRAINT "result_shares_hash_ck" CHECK (char_length("token_hash") = 64),
  CONSTRAINT "result_shares_revoke_ck" CHECK ("revoked_at" IS NULL OR "revoked_at" >= "created_at")
);

CREATE UNIQUE INDEX IF NOT EXISTS "result_shares_hash_idx"
  ON "quant"."result_shares" ("token_hash");

CREATE UNIQUE INDEX IF NOT EXISTS "result_shares_one_active_idx"
  ON "quant"."result_shares" ("account_id", "run_id")
  WHERE "revoked_at" IS NULL;

CREATE TABLE IF NOT EXISTS "quant"."share_reads" (
  "bucket"    text NOT NULL,
  "read_at"   timestamptz NOT NULL,
  CONSTRAINT "share_reads_bucket_ck" CHECK (char_length("bucket") BETWEEN 1 AND 64)
);

CREATE INDEX IF NOT EXISTS "share_reads_bucket_idx"
  ON "quant"."share_reads" ("bucket", "read_at");

CREATE OR REPLACE FUNCTION "quant"."reject_share_rewrite"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'quant.share_immutable — share links cannot be deleted';
  END IF;
  IF NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.run_id IS DISTINCT FROM OLD.run_id
     OR NEW.seq IS DISTINCT FROM OLD.seq
     OR NEW.write_key IS DISTINCT FROM OLD.write_key
     OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION 'quant.share_immutable — a share link cannot be rewritten';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "result_shares_revoke_only" ON "quant"."result_shares";
CREATE TRIGGER "result_shares_revoke_only"
  BEFORE UPDATE OR DELETE ON "quant"."result_shares"
  FOR EACH ROW EXECUTE FUNCTION "quant"."reject_share_rewrite"();
