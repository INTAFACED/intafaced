-- svc-support · a customer's grant for support to read, and the reads under it (RC-support-public-01, J-support-public-20 #2)
-- Reversal: 20261123030000_read_grants.down.sql
--
-- read_grants: one row each time a customer, on their own request, grants support a read for a set time. The newest row
-- of a request is the grant that counts; it ends at its own `expires_at`.
-- read_grant_reads: one row per read the desk was answered under a grant: what was read, who read it and when. No figure
-- is kept. The customer reads these rows on their request.
-- The desk's audit of every ask stays in verification_audit, whose outcome already takes any code and `read`.
-- Both tables refuse update and delete.

CREATE TABLE IF NOT EXISTS "support"."read_grants" (
  "id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "ticket_id" uuid NOT NULL REFERENCES "support"."tickets" ("id") ON DELETE RESTRICT,
  "user_id" text NOT NULL CHECK (char_length("user_id") BETWEEN 1 AND 128),
  "granted_at" timestamptz NOT NULL,
  "expires_at" timestamptz NOT NULL,
  CHECK ("expires_at" > "granted_at")
);
CREATE INDEX IF NOT EXISTS "read_grants_ticket_idx" ON "support"."read_grants" ("ticket_id", "id" DESC);

CREATE TABLE IF NOT EXISTS "support"."read_grant_reads" (
  "id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "ticket_id" uuid NOT NULL REFERENCES "support"."tickets" ("id") ON DELETE RESTRICT,
  "kind" text NOT NULL CHECK ("kind" IN ('balance', 'fills', 'destination')),
  "read_by" text NOT NULL CHECK (char_length("read_by") BETWEEN 1 AND 128),
  "read_at" timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS "read_grant_reads_ticket_idx" ON "support"."read_grant_reads" ("ticket_id", "id" DESC);

CREATE OR REPLACE FUNCTION "support"."read_grants_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "read_grants_append_only_trg" ON "support"."read_grants";
CREATE TRIGGER "read_grants_append_only_trg"
  BEFORE UPDATE OR DELETE ON "support"."read_grants"
  FOR EACH ROW EXECUTE FUNCTION "support"."read_grants_append_only"();

DROP TRIGGER IF EXISTS "read_grant_reads_append_only_trg" ON "support"."read_grant_reads";
CREATE TRIGGER "read_grant_reads_append_only_trg"
  BEFORE UPDATE OR DELETE ON "support"."read_grant_reads"
  FOR EACH ROW EXECUTE FUNCTION "support"."read_grants_append_only"();
