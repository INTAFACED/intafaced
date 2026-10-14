-- intafaced:destructive — reversal of 0039_pay_permission_seq_commit_order.sql
--
-- Restores insert-time seq. A revoke that commits after a grant of the same
-- triple can again lose to that grant. The journal rows themselves stay.

DROP TRIGGER IF EXISTS "merchant_permission_events_assign_seq_trg" ON "pay"."merchant_permission_events";
DROP TRIGGER IF EXISTS "merchant_permission_events_clear_seq_trg" ON "pay"."merchant_permission_events";

DO $$
DECLARE
  seq_name text := pg_get_serial_sequence('pay.merchant_permission_events', 'seq');
  pending uuid;
BEGIN
  IF seq_name IS NULL THEN
    RAISE EXCEPTION 'pay.merchant_permission_events.seq has no sequence';
  END IF;

  FOR pending IN SELECT id FROM "pay"."merchant_permission_events" WHERE "seq" IS NULL LOOP
    PERFORM set_config('pay.permission_event_seq_assign', pending::text, true);
    UPDATE "pay"."merchant_permission_events"
       SET "seq" = nextval(seq_name::regclass)
     WHERE "id" = pending
       AND "seq" IS NULL;
  END LOOP;

  EXECUTE format(
    'ALTER TABLE "pay"."merchant_permission_events" ALTER COLUMN "seq" SET DEFAULT nextval(%L::regclass)',
    seq_name
  );
END $$;

ALTER TABLE "pay"."merchant_permission_events" ALTER COLUMN "seq" SET NOT NULL;

CREATE OR REPLACE FUNCTION "pay"."merchant_permission_events_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'pay.merchant_permission_events is append-only: % is not permitted. Revoke with a new row, do not edit the old one.', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP FUNCTION IF EXISTS "pay"."merchant_permission_events_assign_seq"();
DROP FUNCTION IF EXISTS "pay"."merchant_permission_events_clear_seq"();
