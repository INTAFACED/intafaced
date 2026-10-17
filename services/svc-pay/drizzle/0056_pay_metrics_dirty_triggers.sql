-- svc-pay · W2 metrics read model: transactional dirty marking + backfill.
-- Reversal: 0056_pay_metrics_dirty_triggers.down.sql
--
-- WHY TRIGGERS AND A DIRTY LOG (and not a poller with a high-water mark).
-- payment_events.seq is a bigserial: a transaction that took seq 41 can commit
-- AFTER one that took 42, so "everything up to the highest seq I saw" skips rows
-- permanently. Marking the key dirty in the SAME transaction as the source write
-- means a source row is visible to a reader exactly when its mark is. The
-- refresher recomputes each marked merchant-day FROM SOURCE and deletes only the
-- mark ids it read, so a write that commits mid-recompute leaves its own mark
-- behind and is picked up next pass. Nothing is added or subtracted
-- incrementally, so the projection cannot drift; it can only lag, and lag is
-- reported (oldest unprocessed mark).
--
-- The triggers touch no application code and add one INSERT per relevant source
-- write. `payments.updated_at`-only updates mark nothing.

CREATE OR REPLACE FUNCTION "pay"."metrics_mark"(p_merchant uuid, p_ts timestamptz) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO "pay"."metrics_dirty" ("merchant_id", "day") VALUES (p_merchant, (p_ts AT TIME ZONE 'UTC')::date)
$$;

CREATE OR REPLACE FUNCTION "pay"."metrics_payments_trg"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM "pay"."metrics_mark"(OLD.merchant_id, OLD.created_at);
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status IS NOT DISTINCT FROM NEW.status
       AND OLD.currency IS NOT DISTINCT FROM NEW.currency
       AND OLD.merchant_id IS NOT DISTINCT FROM NEW.merchant_id
       AND OLD.created_at IS NOT DISTINCT FROM NEW.created_at THEN
      RETURN NEW;
    END IF;
    PERFORM "pay"."metrics_mark"(OLD.merchant_id, OLD.created_at);
  END IF;
  PERFORM "pay"."metrics_mark"(NEW.merchant_id, NEW.created_at);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "payments_metrics_dirty_trg" ON "pay"."payments";
CREATE TRIGGER "payments_metrics_dirty_trg"
  AFTER INSERT OR UPDATE OR DELETE ON "pay"."payments"
  FOR EACH ROW EXECUTE FUNCTION "pay"."metrics_payments_trg"();

-- captured / refunded events: the event's own day, the payment's created day
-- (unsettled_net, link usage) and the payment's capture day (refund cohort).
CREATE OR REPLACE FUNCTION "pay"."metrics_events_trg"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  p RECORD;
  first_capture timestamptz;
BEGIN
  SELECT merchant_id, created_at INTO p FROM "pay"."payments" WHERE id = NEW.payment_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  PERFORM "pay"."metrics_mark"(p.merchant_id, NEW.ts);
  PERFORM "pay"."metrics_mark"(p.merchant_id, p.created_at);
  IF NEW.event = 'refunded' THEN
    SELECT min(ts) INTO first_capture FROM "pay"."payment_events" WHERE payment_id = NEW.payment_id AND event = 'captured';
    IF first_capture IS NOT NULL THEN
      PERFORM "pay"."metrics_mark"(p.merchant_id, first_capture);
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "payment_events_metrics_dirty_trg" ON "pay"."payment_events";
CREATE TRIGGER "payment_events_metrics_dirty_trg"
  AFTER INSERT ON "pay"."payment_events"
  FOR EACH ROW WHEN (NEW.event IN ('captured', 'refunded'))
  EXECUTE FUNCTION "pay"."metrics_events_trg"();

CREATE OR REPLACE FUNCTION "pay"."metrics_settlements_trg"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM "pay"."metrics_mark"(OLD.merchant_id, OLD.created_at);
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status IS NOT DISTINCT FROM NEW.status
       AND OLD.asset_id IS NOT DISTINCT FROM NEW.asset_id
       AND OLD.gross IS NOT DISTINCT FROM NEW.gross
       AND OLD.fees IS NOT DISTINCT FROM NEW.fees
       AND OLD.net IS NOT DISTINCT FROM NEW.net
       AND OLD.merchant_id IS NOT DISTINCT FROM NEW.merchant_id
       AND OLD.created_at IS NOT DISTINCT FROM NEW.created_at THEN
      RETURN NEW;
    END IF;
    PERFORM "pay"."metrics_mark"(OLD.merchant_id, OLD.created_at);
  END IF;
  PERFORM "pay"."metrics_mark"(NEW.merchant_id, NEW.created_at);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "settlements_metrics_dirty_trg" ON "pay"."settlements";
CREATE TRIGGER "settlements_metrics_dirty_trg"
  AFTER INSERT OR UPDATE OR DELETE ON "pay"."settlements"
  FOR EACH ROW EXECUTE FUNCTION "pay"."metrics_settlements_trg"();

-- A checkout session attaching to a payment changes that payment's link usage.
CREATE OR REPLACE FUNCTION "pay"."metrics_sessions_trg"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  p RECORD;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.payment_id IS NOT DISTINCT FROM NEW.payment_id AND OLD.link_id IS NOT DISTINCT FROM NEW.link_id THEN
    RETURN NEW;
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.payment_id IS NOT NULL THEN
    SELECT merchant_id, created_at INTO p FROM "pay"."payments" WHERE id = OLD.payment_id;
    IF FOUND THEN PERFORM "pay"."metrics_mark"(p.merchant_id, p.created_at); END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.payment_id IS NOT NULL THEN
    SELECT merchant_id, created_at INTO p FROM "pay"."payments" WHERE id = NEW.payment_id;
    IF FOUND THEN PERFORM "pay"."metrics_mark"(p.merchant_id, p.created_at); END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

DROP TRIGGER IF EXISTS "checkout_sessions_metrics_dirty_trg" ON "pay"."checkout_sessions";
CREATE TRIGGER "checkout_sessions_metrics_dirty_trg"
  AFTER INSERT OR UPDATE OR DELETE ON "pay"."checkout_sessions"
  FOR EACH ROW EXECUTE FUNCTION "pay"."metrics_sessions_trg"();

-- BACKFILL: rows that existed before the triggers did. Marking is enough; the
-- refresher computes them from source like everything else.
INSERT INTO "pay"."metrics_dirty" ("merchant_id", "day")
SELECT DISTINCT k.merchant_id, k.day FROM (
  SELECT p.merchant_id, (p.created_at AT TIME ZONE 'UTC')::date AS day FROM "pay"."payments" p
  UNION
  SELECT p.merchant_id, (e.ts AT TIME ZONE 'UTC')::date
    FROM "pay"."payment_events" e JOIN "pay"."payments" p ON p.id = e.payment_id
   WHERE e.event IN ('captured', 'refunded')
  UNION
  SELECT p.merchant_id, (c.ts AT TIME ZONE 'UTC')::date
    FROM "pay"."payments" p
    JOIN (SELECT payment_id, min(ts) AS ts FROM "pay"."payment_events" WHERE event = 'captured' GROUP BY payment_id) c
      ON c.payment_id = p.id
  UNION
  SELECT s.merchant_id, (s.created_at AT TIME ZONE 'UTC')::date FROM "pay"."settlements" s
) k;
