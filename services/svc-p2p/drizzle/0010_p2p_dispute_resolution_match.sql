-- svc-p2p · a disputed escrow terminates only as the human ruling it holds.
-- Reversal: 0010_p2p_dispute_resolution_match.down.sql
--
-- NOT tagged `intafaced:destructive`: replaces a trigger function. No table,
-- column, or row changes, and no UPDATE.
--
-- 0003 reads p2p_disputes.status and moderator_id, then accepts any terminal
-- resolution. A dispute already resolved as refund by a natural-person id still
-- allowed UPDATE p2p_trades SET status='released', resolution='released'.
-- settleOnce posts escrowRelease from that trade row, so the buyer receives
-- the escrow the ruling gave back to the seller. The same guard accepted
-- resolution='voided', and that settlement posts nothing.
--
-- The function now also reads p2p_disputes.resolution. release matches only
-- trade resolution released; refund matches only refunded. voided is not a
-- ruling. The UPDATE is refused (check_violation) so settleOnce never sees it.

CREATE OR REPLACE FUNCTION "p2p"."p2p_trades_disputed_needs_ruling"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  d_exists boolean;
  d_status text;
  d_moderator text;
  d_resolution text;
BEGIN
  -- `SELECT true, …` rather than testing FOUND afterwards: FOUND is set by the
  -- last statement that touched rows, and a guard whose correctness depends on
  -- no other statement having run since is a guard waiting for an edit.
  SELECT true, "status"::text, "moderator_id", "resolution"::text
    INTO d_exists, d_status, d_moderator, d_resolution
    FROM "p2p"."p2p_disputes" WHERE "trade_id" = NEW."id";

  -- UNDER DISPUTE — three ways to be, so that changing status first does not
  -- change the answer. See 0003 section A.
  IF NOT (OLD."status" = 'disputed' OR NEW."status" = 'disputed' OR coalesce(d_exists, false)) THEN
    RETURN NEW;
  END IF;

  -- (B) A disputed trade may not quietly stop being disputed.
  IF OLD."status" = 'disputed' AND NEW."status" <> 'disputed' AND NEW."resolution" IS NULL THEN
    RAISE EXCEPTION
      'p2p: trade % is disputed and cannot return to a live state — the only edges out of `disputed` are '
      'released and cancelled, and both require an attributed human ruling. Un-disputing first was how a '
      'backstop timer terminated an escrow in two statements instead of one', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- (C) The terminal write itself. It must be the resolution the dispute holds.
  IF OLD."resolution" IS NULL AND NEW."resolution" IS NOT NULL THEN
    IF NOT coalesce(d_exists, false) THEN
      RAISE EXCEPTION
        'p2p: trade % was disputed and its dispute record is missing — an escrow cannot terminate on a ruling '
        'that no longer exists', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;

    IF d_status IS DISTINCT FROM 'resolved'
       OR NOT "p2p"."is_natural_person_id"(d_moderator) THEN
      RAISE EXCEPTION
        'p2p: a disputed escrow terminates only on a human ruling — trade % has no attributed moderator '
        'decision (dispute is %, ruled by %). The moderator must be a natural-person id: a lowercase '
        'canonical UUID, the same identifier space as the two parties. A machine principal is not one, '
        'whatever it is called', NEW."id", coalesce(d_status, 'absent'), coalesce(d_moderator, 'nobody')
        USING ERRCODE = 'check_violation';
    END IF;

    -- dispute_resolution and trade_resolution are different enums.
    -- release → released (escrowRelease to the buyer). refund → refunded.
    -- voided is not a ruling and must not terminate the escrow by posting nothing.
    IF NOT (
         (d_resolution = 'release' AND NEW."resolution"::text = 'released')
      OR (d_resolution = 'refund' AND NEW."resolution"::text = 'refunded')
    ) THEN
      RAISE EXCEPTION
        'p2p: trade % terminal resolution % does not match the human ruling %. A disputed escrow settles only '
        'as that ruling — a mismatched release posts escrowRelease to the buyer, and voided posts nothing',
        NEW."id", NEW."resolution", coalesce(d_resolution, 'none')
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "p2p_trades_disputed_needs_ruling_trg" ON "p2p"."p2p_trades";
CREATE TRIGGER "p2p_trades_disputed_needs_ruling_trg"
  BEFORE UPDATE ON "p2p"."p2p_trades"
  FOR EACH ROW EXECUTE FUNCTION "p2p"."p2p_trades_disputed_needs_ruling"();
