-- svc-p2p · a resolved dispute's ruling cannot change.
-- Reversal: 0013_p2p_dispute_ruling_frozen.down.sql
--
-- NOT tagged `intafaced:destructive`: it drops no table, no column and no row.
-- The trigger only ever refuses. Dispute rows are not deleted. `amount` and
-- original trade terms are not rewritten. `0010` and `0011` stay as they are.
--
-- WHAT WAS WRONG
--
-- `0000` lines 265–270 (`p2p_disputes_resolved_is_attributed_ck`) stay true when
-- `resolution` changes from `release` to `refund` while `status`,
-- `moderator_id`, and `resolved_at` stay populated. The evidence trigger in
-- the same file returns immediately when evidence is unchanged, so it does not
-- freeze the ruling. After the escrow has moved, that rewrite names the
-- opposite party from the one who was paid.
--
-- A CHECK cannot see the previous resolution. The first write, open with a
-- null resolution to resolved with `release` or `refund`, stays legal. A later
-- update that names the other party does not.
--
-- WHY 0013 AND NOT AN EDIT TO 0000
--
-- `scripts/migrate.ts` tracks applied migrations by filename in
-- `p2p.__migrations`. `0000` will not run again on a database that already
-- applied it. Same reason `0010` and `0011` are their own files.
--
-- A book that already holds a resolved dispute naming the opposite party from
-- the trade's paid resolution fails here. Those rows are not updated and not
-- deleted.

DO $$
DECLARE
  violating bigint;
BEGIN
  SELECT count(*) INTO violating
    FROM "p2p"."p2p_disputes" d
    JOIN "p2p"."p2p_trades" t ON t."id" = d."trade_id"
   WHERE d."status" = 'resolved'
     AND (
       (t."resolution" = 'released'::"p2p"."trade_resolution"
          AND d."resolution" IS DISTINCT FROM 'release'::"p2p"."dispute_resolution")
       OR (t."resolution" = 'refunded'::"p2p"."trade_resolution"
          AND d."resolution" IS DISTINCT FROM 'refund'::"p2p"."dispute_resolution")
     );
  IF violating > 0 THEN
    RAISE EXCEPTION
      'p2p: refusing p2p_disputes_resolved_ruling_frozen — % resolved dispute(s) already name the opposite party from the one the trade paid. Rows are not deleted and resolution and original terms are not rewritten.',
      violating
      USING ERRCODE = 'check_violation';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION "p2p"."p2p_disputes_resolved_ruling_frozen"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" = 'resolved'
     AND ROW(NEW."status", NEW."resolution", NEW."moderator_id", NEW."resolved_at", NEW."resolution_notes", NEW."trade_id", NEW."opened_by")
       IS DISTINCT FROM ROW(OLD."status", OLD."resolution", OLD."moderator_id", OLD."resolved_at", OLD."resolution_notes", OLD."trade_id", OLD."opened_by") THEN
    RAISE EXCEPTION
      'p2p: a resolved dispute ruling cannot change — p2p_disputes_resolved_ruling_frozen dispute % stays %',
      OLD."id", OLD."resolution"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "p2p_disputes_resolved_ruling_frozen_trg" ON "p2p"."p2p_disputes";
CREATE TRIGGER "p2p_disputes_resolved_ruling_frozen_trg"
  BEFORE UPDATE ON "p2p"."p2p_disputes"
  FOR EACH ROW EXECUTE FUNCTION "p2p"."p2p_disputes_resolved_ruling_frozen"();
