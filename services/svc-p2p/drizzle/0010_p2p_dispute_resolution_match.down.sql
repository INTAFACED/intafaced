-- Reversal of 0010_p2p_dispute_resolution_match.sql.
--
-- NOT tagged `intafaced:destructive`: this drops no table, no column and no
-- row. It restores the 0003 function, which again reads only dispute status
-- and moderator_id. A refund ruling can once more be rewritten as released
-- (escrowRelease to the buyer) or voided (a settlement that posts nothing).
--
-- Do not run it against a database holding escrow.

CREATE OR REPLACE FUNCTION "p2p"."p2p_trades_disputed_needs_ruling"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  d_exists boolean;
  d_status text;
  d_moderator text;
BEGIN
  SELECT true, "status"::text, "moderator_id"
    INTO d_exists, d_status, d_moderator
    FROM "p2p"."p2p_disputes" WHERE "trade_id" = NEW."id";

  IF NOT (OLD."status" = 'disputed' OR NEW."status" = 'disputed' OR coalesce(d_exists, false)) THEN
    RETURN NEW;
  END IF;

  IF OLD."status" = 'disputed' AND NEW."status" <> 'disputed' AND NEW."resolution" IS NULL THEN
    RAISE EXCEPTION
      'p2p: trade % is disputed and cannot return to a live state — the only edges out of `disputed` are '
      'released and cancelled, and both require an attributed human ruling. Un-disputing first was how a '
      'backstop timer terminated an escrow in two statements instead of one', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

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
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "p2p_trades_disputed_needs_ruling_trg" ON "p2p"."p2p_trades";
CREATE TRIGGER "p2p_trades_disputed_needs_ruling_trg"
  BEFORE UPDATE ON "p2p"."p2p_trades"
  FOR EACH ROW EXECUTE FUNCTION "p2p"."p2p_trades_disputed_needs_ruling"();
