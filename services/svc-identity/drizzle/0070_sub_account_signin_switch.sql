-- Sub-account sign-in control and account switching (I-account-lifecycle-04). Sign-in for a sub-account is off by
-- default; each change is audited. Every switch from the main account into a sub-account is recorded (the owner's
-- minimum interval reads the last one). No balance, no ledger.
-- Reversal: 0070_sub_account_signin_switch.down.sql

ALTER TABLE "identity"."sub_accounts" ADD COLUMN IF NOT EXISTS "signin_enabled" boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "identity"."sub_account_signin_audit" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "sub_account_id" uuid NOT NULL REFERENCES "identity"."sub_accounts" ("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL,
  "session_id" text NOT NULL,
  "enabled" boolean NOT NULL,
  "at" timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS "sub_account_signin_audit_sub_idx" ON "identity"."sub_account_signin_audit" ("sub_account_id", "at" DESC);

CREATE TABLE IF NOT EXISTS "identity"."sub_account_switches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL,
  "sub_account_id" uuid NOT NULL REFERENCES "identity"."sub_accounts" ("id") ON DELETE CASCADE,
  "session_id" text NOT NULL,
  "at" timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS "sub_account_switches_user_idx" ON "identity"."sub_account_switches" ("user_id", "at" DESC);

-- A switch runs on its own short-lived session row (no refresh token is ever issued for it), so the edge's session
-- check can kill it. Revoking or freezing the sub-account revokes every switch session into it, in the same statement.
ALTER TABLE "identity"."sub_account_switches" ADD COLUMN IF NOT EXISTS "switch_session_id" uuid REFERENCES "identity"."sessions" ("id") ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION "identity"."sub_account_switch_sessions_kill"() RETURNS trigger AS $$
BEGIN
  IF (NEW.revoked AND NOT OLD.revoked) OR (NEW.frozen = 1 AND OLD.frozen <> 1) THEN
    UPDATE "identity"."sessions" SET revoked = true
     WHERE revoked = false
       AND id IN (SELECT switch_session_id FROM "identity"."sub_account_switches" WHERE sub_account_id = NEW.id AND switch_session_id IS NOT NULL);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "sub_account_switch_sessions_kill" ON "identity"."sub_accounts";
CREATE TRIGGER "sub_account_switch_sessions_kill" AFTER UPDATE OF revoked, frozen ON "identity"."sub_accounts"
  FOR EACH ROW EXECUTE FUNCTION "identity"."sub_account_switch_sessions_kill"();

