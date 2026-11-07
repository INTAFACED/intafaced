-- svc-support · the scam warning on a first-time payee, read once per person and payee (BK-safe-02, J-bank-18 #2)
-- Reversal: 20261107094608_payee_warnings.down.sql
--
-- payee_warnings_seen: one row when a person has read the scam warning for one payee. The row holds the two account ids
-- and when; no amount, no handle. Rows refuse update and delete.

CREATE TABLE IF NOT EXISTS "support"."payee_warnings_seen" (
  "user_id" uuid NOT NULL,
  "payee_id" uuid NOT NULL,
  "seen_at" timestamptz NOT NULL,
  PRIMARY KEY ("user_id", "payee_id"),
  CONSTRAINT "payee_warnings_seen_not_self" CHECK ("user_id" <> "payee_id")
);

DROP TRIGGER IF EXISTS "payee_warnings_seen_append_only_trg" ON "support"."payee_warnings_seen";
CREATE TRIGGER "payee_warnings_seen_append_only_trg"
  BEFORE UPDATE OR DELETE ON "support"."payee_warnings_seen"
  FOR EACH ROW EXECUTE FUNCTION "support"."safety_cases_append_only"();
