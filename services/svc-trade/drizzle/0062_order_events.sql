-- trade.orders · append-only execution reports for a child (EXE-1)
-- Reversal: 0062_order_events.down.sql
--
-- One row per transition. The row is not a balance and not a fill. Filled
-- quantity still comes from trade.fills. These rows cannot be updated or deleted.

CREATE TABLE IF NOT EXISTS "trade"."order_events" (
  "id"         bigserial PRIMARY KEY,
  "order_id"   uuid NOT NULL,
  "parent_id"  text,
  "kind"       text NOT NULL,
  "quantity"   numeric(38, 18),
  "price"      numeric(38, 18),
  "code"       text NOT NULL,
  "at"         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "order_events_kind_ck" CHECK (
    "kind" IN ('ack', 'reject', 'rest', 'amend', 'cancel', 'partial', 'fill', 'expire')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "order_events_transition_uq"
  ON "trade"."order_events" ("order_id", "kind", "code");

CREATE INDEX IF NOT EXISTS "order_events_parent_at_idx"
  ON "trade"."order_events" ("parent_id", "at", "id");

CREATE OR REPLACE FUNCTION "trade"."order_events_immutable"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % refused (execution reports cannot be changed)',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS "order_events_immutable" ON "trade"."order_events";
CREATE TRIGGER "order_events_immutable"
  BEFORE UPDATE OR DELETE ON "trade"."order_events"
  FOR EACH ROW
  EXECUTE FUNCTION "trade"."order_events_immutable"();

CREATE OR REPLACE FUNCTION "trade"."order_events_no_truncate"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: TRUNCATE refused (execution reports cannot be changed)',
    TG_TABLE_NAME
    USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS "order_events_no_truncate" ON "trade"."order_events";
CREATE TRIGGER "order_events_no_truncate"
  BEFORE TRUNCATE ON "trade"."order_events"
  FOR EACH STATEMENT
  EXECUTE FUNCTION "trade"."order_events_no_truncate"();
