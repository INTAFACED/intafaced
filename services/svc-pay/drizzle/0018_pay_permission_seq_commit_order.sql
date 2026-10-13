-- intafaced:destructive — drops the bigserial DEFAULT and NOT NULL on seq so the
-- value can stay unset until the inserting transaction commits. No row is
-- deleted, and every seq already stored stays where it is.
--
-- seq is the effective-permission order: the greatest value for a
-- (grantee, subject, area) triple wins, which is what
-- merchant_permission_events_triple_idx is for.
--
-- bigserial calls nextval when the INSERT runs, not when the transaction
-- commits. A revoke can take seq N, a grant of the same triple can take N+1
-- and commit, and the revoke can commit afterwards. Once both are visible the
-- grant is still the greatest seq, so the revoke never takes effect.
--
-- Assignment moves to a deferred constraint trigger. It runs at COMMIT, takes
-- one transaction advisory lock for this table, then draws the next seq. The
-- lock is held until that commit finishes, so the transaction that commits
-- later receives the greater seq. The grant can still insert and commit while
-- the revoke transaction is open, because the lock is not taken at INSERT.

ALTER TABLE "pay"."merchant_permission_events" ALTER COLUMN "seq" DROP DEFAULT;

ALTER TABLE "pay"."merchant_permission_events" ALTER COLUMN "seq" DROP NOT NULL;

-- A writer must not choose seq. The commit trigger is the only assigner.
-- This server rejects DEFERRABLE CHECK constraints, so the trigger itself
-- refuses to finish the commit when it cannot fill seq.
CREATE OR REPLACE FUNCTION "pay"."merchant_permission_events_clear_seq"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.seq := NULL;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "merchant_permission_events_clear_seq_trg" ON "pay"."merchant_permission_events";
CREATE TRIGGER "merchant_permission_events_clear_seq_trg"
  BEFORE INSERT ON "pay"."merchant_permission_events"
  FOR EACH ROW EXECUTE FUNCTION "pay"."merchant_permission_events_clear_seq"();

CREATE OR REPLACE FUNCTION "pay"."merchant_permission_events_assign_seq"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  seq_name text;
  assigned bigint;
BEGIN
  -- Held until this transaction ends, which is the rest of COMMIT. The next
  -- committer blocks here, so a later commit gets a greater seq.
  PERFORM pg_advisory_xact_lock('pay.merchant_permission_events'::regclass::oid::bigint);

  seq_name := pg_get_serial_sequence('pay.merchant_permission_events', 'seq');
  IF seq_name IS NULL THEN
    RAISE EXCEPTION 'pay.merchant_permission_events.seq has no sequence to assign at commit'
      USING ERRCODE = 'restrict_violation';
  END IF;

  assigned := nextval(seq_name::regclass);
  -- The append-only trigger allows this one update, and only this one.
  PERFORM set_config('pay.permission_event_seq_assign', NEW.id::text, true);

  UPDATE "pay"."merchant_permission_events"
     SET "seq" = assigned
   WHERE "id" = NEW.id
     AND "seq" IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'pay.merchant_permission_events seq was not assigned for %', NEW.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS "merchant_permission_events_assign_seq_trg" ON "pay"."merchant_permission_events";
CREATE CONSTRAINT TRIGGER "merchant_permission_events_assign_seq_trg"
  AFTER INSERT ON "pay"."merchant_permission_events"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION "pay"."merchant_permission_events_assign_seq"();

-- Still append-only for every application change. The commit trigger is the
-- one writer allowed to fill a null seq, and it may change nothing else.
CREATE OR REPLACE FUNCTION "pay"."merchant_permission_events_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND current_setting('pay.permission_event_seq_assign', true) IS NOT DISTINCT FROM OLD.id::text
     AND OLD.seq IS NULL
     AND NEW.seq IS NOT NULL
     AND NEW.id IS NOT DISTINCT FROM OLD.id
     AND NEW.grantee_merchant_id IS NOT DISTINCT FROM OLD.grantee_merchant_id
     AND NEW.subject_merchant_id IS NOT DISTINCT FROM OLD.subject_merchant_id
     AND NEW.area IS NOT DISTINCT FROM OLD.area
     AND NEW.action IS NOT DISTINCT FROM OLD.action
     AND NEW.reason IS NOT DISTINCT FROM OLD.reason
     AND NEW.actor_id IS NOT DISTINCT FROM OLD.actor_id
     AND NEW.actor_merchant_id IS NOT DISTINCT FROM OLD.actor_merchant_id
     AND NEW.actor_scope IS NOT DISTINCT FROM OLD.actor_scope
     AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'pay.merchant_permission_events is append-only: % is not permitted. Revoke with a new row, do not edit the old one.', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
