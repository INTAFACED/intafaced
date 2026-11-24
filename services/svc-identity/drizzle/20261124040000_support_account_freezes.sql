-- svc-identity · support account freezes (J-support-public-20 #7, RC-support-public-07, RC-support-public-06)
-- Reversal: 20261124040000_support_account_freezes.down.sql
--
-- One row per (support request, trading restriction version): the record that a support agent froze a customer's
-- account from a request. The freeze itself is the account's trading restriction (trading_restrictions.restricted),
-- written in the same transaction; `restriction_version` is its version once the ask holds, so asking again from the
-- same request while it holds answers the first row, and an ask after staff lifted it is a new row. `restriction_set`
-- says whether this ask set it (false when one already held). The row holds no amount. It refuses delete, and an
-- update other than the relay's one `published_at` stamp (the `supportAccountFrozen` event is announced from it).

CREATE TABLE IF NOT EXISTS "identity"."support_account_freezes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "identity"."users" ("id") ON DELETE CASCADE,
  "ticket_id" uuid NOT NULL,
  "operator_id" uuid NOT NULL,
  "reason" text NOT NULL CHECK (char_length("reason") BETWEEN 1 AND 500),
  "restriction_version" bigint NOT NULL,
  "restriction_set" boolean NOT NULL,
  "recorded_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  "published_at" timestamptz,
  UNIQUE ("ticket_id", "restriction_version")
);
CREATE INDEX IF NOT EXISTS "support_account_freezes_user_idx" ON "identity"."support_account_freezes" ("user_id", "recorded_at" DESC);
CREATE INDEX IF NOT EXISTS "support_account_freezes_unpublished_idx"
  ON "identity"."support_account_freezes" ("recorded_at") WHERE "published_at" IS NULL;

CREATE OR REPLACE FUNCTION "identity"."support_account_freezes_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- A cascade from removing the user row is the account's erasure, not an edit of the record.
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  -- The relay stamps published_at once; nothing else on the row ever changes.
  IF TG_OP = 'UPDATE' AND OLD."published_at" IS NULL AND NEW."published_at" IS NOT NULL
     AND (NEW."id", NEW."user_id", NEW."ticket_id", NEW."operator_id", NEW."reason", NEW."restriction_version",
          NEW."restriction_set", NEW."recorded_at")
         IS NOT DISTINCT FROM
         (OLD."id", OLD."user_id", OLD."ticket_id", OLD."operator_id", OLD."reason", OLD."restriction_version",
          OLD."restriction_set", OLD."recorded_at") THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'identity.support_account_freezes is append-only';
END
$$;
DROP TRIGGER IF EXISTS "support_account_freezes_append_only" ON "identity"."support_account_freezes";
CREATE TRIGGER "support_account_freezes_append_only" BEFORE UPDATE OR DELETE ON "identity"."support_account_freezes"
  FOR EACH ROW EXECUTE FUNCTION "identity"."support_account_freezes_append_only"();
