-- A returned withdrawal (W-withdraw-07, wallet-withdraw-R01): a sent withdrawal whose funds came back from the outside.
-- Nothing is booked here: the returned-funds ledger recipe does not exist yet (a named ledger-owner job), so a return
-- is recorded and parked with its blocker named, and no balance moves. One return per withdrawal.
CREATE TABLE IF NOT EXISTS "pay"."withdrawal_returns" (
  "withdrawal_id" uuid PRIMARY KEY REFERENCES "pay"."withdrawals" ("id"),
  "return_ref" text NOT NULL,
  "asset_id" text NOT NULL,
  "amount" numeric(38,18) NOT NULL,
  "reason" text NOT NULL,
  "state" text NOT NULL DEFAULT 'parked',
  "blocker" text NOT NULL,
  "recorded_by" text NOT NULL,
  "recorded_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "withdrawal_returns_amount_positive" CHECK ("amount" > 0),
  CONSTRAINT "withdrawal_returns_state_ck" CHECK ("state" IN ('parked')),
  CONSTRAINT "withdrawal_returns_text_ck" CHECK (length(btrim("return_ref")) > 0 AND length(btrim("reason")) > 0
    AND length(btrim("blocker")) > 0 AND length(btrim("recorded_by")) > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS "withdrawal_returns_ref_uq" ON "pay"."withdrawal_returns" ("return_ref");
CREATE INDEX IF NOT EXISTS "withdrawal_returns_recorded_idx" ON "pay"."withdrawal_returns" ("recorded_at" DESC, "withdrawal_id" DESC);

CREATE TABLE IF NOT EXISTS "pay"."withdrawal_return_events" (
  "seq" bigserial PRIMARY KEY,
  "withdrawal_id" uuid NOT NULL REFERENCES "pay"."withdrawals" ("id"),
  "kind" text NOT NULL,
  "actor_id" text NOT NULL,
  "detail" jsonb NOT NULL,
  "at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "withdrawal_return_events_actor_not_blank" CHECK (length(btrim("actor_id")) > 0)
);
CREATE INDEX IF NOT EXISTS "withdrawal_return_events_subject_idx" ON "pay"."withdrawal_return_events" ("withdrawal_id", "seq" DESC);

CREATE OR REPLACE FUNCTION "pay"."withdrawal_returns_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on pay.% is not permitted: a recorded return is never edited or deleted. Record a new event instead.', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS "withdrawal_return_events_append_only_trg" ON "pay"."withdrawal_return_events";
CREATE TRIGGER "withdrawal_return_events_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pay"."withdrawal_return_events"
  FOR EACH ROW EXECUTE FUNCTION "pay"."withdrawal_returns_append_only"();

DROP TRIGGER IF EXISTS "withdrawal_returns_append_only_trg" ON "pay"."withdrawal_returns";
CREATE TRIGGER "withdrawal_returns_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pay"."withdrawal_returns"
  FOR EACH ROW EXECUTE FUNCTION "pay"."withdrawal_returns_append_only"();
