-- UTXO inventory and consolidation (W-custody-ops-13, wallet-custody-ops-020). NOTHING HERE HOLDS A BALANCE: the ledger is
-- the only book. `utxo_records` is the inventory the node last reported for a custody wallet (a cache the listing
-- refreshes), with a label and a state. A consolidation is an intent row written BEFORE the node is asked to build and
-- broadcast, keyed by the caller's business key, with its frozen input set; the outcome is a separate append-only row, so
-- a crash between the two leaves an intent with no outcome and a retry resumes the same key. The triggers that make a
-- consolidation due (a UTXO count, a low fee) are owner-set in `utxo_trigger_events`; none means blank and it refuses.
CREATE TABLE IF NOT EXISTS "pay"."utxo_records" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "wallet_id" uuid NOT NULL REFERENCES "pay"."custody_wallets" ("wallet_id"),
  "txid" text NOT NULL,
  "vout" integer NOT NULL,
  "amount" numeric(38,18) NOT NULL,
  "confirmations" integer NOT NULL,
  "state" text NOT NULL,
  "label" text,
  "first_seen_at" timestamptz NOT NULL,
  "last_seen_at" timestamptz NOT NULL,
  CONSTRAINT "utxo_records_outpoint_uq" UNIQUE ("wallet_id", "txid", "vout"),
  CONSTRAINT "utxo_records_state_ck" CHECK ("state" IN ('available', 'reserved', 'spent')),
  CONSTRAINT "utxo_records_amount_positive" CHECK ("amount" > 0),
  CONSTRAINT "utxo_records_vout_ck" CHECK ("vout" >= 0 AND "confirmations" >= 0),
  CONSTRAINT "utxo_records_label_ck" CHECK ("label" IS NULL OR length(btrim("label")) > 0)
);
CREATE INDEX IF NOT EXISTS "utxo_records_wallet_state_idx" ON "pay"."utxo_records" ("wallet_id", "state");

CREATE TABLE IF NOT EXISTS "pay"."utxo_label_events" (
  "seq" bigserial PRIMARY KEY,
  "utxo_id" uuid NOT NULL REFERENCES "pay"."utxo_records" ("id"),
  "label" text,
  "set_by" text NOT NULL,
  "set_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "utxo_label_events_actor_not_blank" CHECK (length(btrim("set_by")) > 0)
);

CREATE TABLE IF NOT EXISTS "pay"."utxo_trigger_events" (
  "seq" bigserial PRIMARY KEY,
  "network_id" text NOT NULL REFERENCES "pay"."network_registry" ("network_id"),
  "min_utxo_count" integer,
  "fee_below" numeric(38,18),
  "fee_unit" text,
  "reason" text NOT NULL,
  "set_by" text NOT NULL,
  "set_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "utxo_trigger_count_ck" CHECK ("min_utxo_count" IS NULL OR "min_utxo_count" >= 2),
  CONSTRAINT "utxo_trigger_fee_ck" CHECK (
    ("fee_below" IS NULL AND "fee_unit" IS NULL) OR ("fee_below" > 0 AND "fee_unit" IS NOT NULL AND length(btrim("fee_unit")) > 0)
  ),
  CONSTRAINT "utxo_trigger_one_set_ck" CHECK ("min_utxo_count" IS NOT NULL OR "fee_below" IS NOT NULL),
  CONSTRAINT "utxo_trigger_text_ck" CHECK (length(btrim("reason")) > 0 AND length(btrim("set_by")) > 0)
);
CREATE INDEX IF NOT EXISTS "utxo_trigger_network_idx" ON "pay"."utxo_trigger_events" ("network_id", "seq" DESC);

CREATE TABLE IF NOT EXISTS "pay"."utxo_consolidations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "intent_ref" text NOT NULL,
  "wallet_id" uuid NOT NULL REFERENCES "pay"."custody_wallets" ("wallet_id"),
  "inputs" jsonb NOT NULL,
  "input_count" integer NOT NULL,
  "total_amount" numeric(38,18) NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "utxo_consolidations_ref_shape" CHECK ("intent_ref" ~ '^[A-Za-z0-9:_.-]{1,128}$'),
  CONSTRAINT "utxo_consolidations_inputs_array" CHECK (jsonb_typeof("inputs") = 'array'),
  CONSTRAINT "utxo_consolidations_count_ck" CHECK ("input_count" >= 2 AND "total_amount" > 0),
  CONSTRAINT "utxo_consolidations_actor_not_blank" CHECK (length(btrim("created_by")) > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS "utxo_consolidations_ref_uq" ON "pay"."utxo_consolidations" ("intent_ref");

CREATE TABLE IF NOT EXISTS "pay"."utxo_consolidation_outcomes" (
  "consolidation_id" uuid PRIMARY KEY REFERENCES "pay"."utxo_consolidations" ("id"),
  "outcome" text NOT NULL,
  "txid" text,
  "failure_code" text,
  "recorded_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "utxo_outcomes_outcome_ck" CHECK (
    ("outcome" = 'broadcast' AND "txid" IS NOT NULL AND "failure_code" IS NULL)
    OR ("outcome" = 'failed' AND "txid" IS NULL AND "failure_code" IS NOT NULL)
  )
);

CREATE OR REPLACE FUNCTION "pay"."custody_utxo_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on pay.% is not permitted: label history, triggers, consolidation intents and their outcomes are never edited or deleted.', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS "utxo_label_events_append_only_trg" ON "pay"."utxo_label_events";
CREATE TRIGGER "utxo_label_events_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pay"."utxo_label_events"
  FOR EACH ROW EXECUTE FUNCTION "pay"."custody_utxo_append_only"();
DROP TRIGGER IF EXISTS "utxo_trigger_events_append_only_trg" ON "pay"."utxo_trigger_events";
CREATE TRIGGER "utxo_trigger_events_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pay"."utxo_trigger_events"
  FOR EACH ROW EXECUTE FUNCTION "pay"."custody_utxo_append_only"();
DROP TRIGGER IF EXISTS "utxo_consolidations_append_only_trg" ON "pay"."utxo_consolidations";
CREATE TRIGGER "utxo_consolidations_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pay"."utxo_consolidations"
  FOR EACH ROW EXECUTE FUNCTION "pay"."custody_utxo_append_only"();
DROP TRIGGER IF EXISTS "utxo_consolidation_outcomes_append_only_trg" ON "pay"."utxo_consolidation_outcomes";
CREATE TRIGGER "utxo_consolidation_outcomes_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pay"."utxo_consolidation_outcomes"
  FOR EACH ROW EXECUTE FUNCTION "pay"."custody_utxo_append_only"();

-- An inventory row is never deleted (a spent output stays as a record).
CREATE OR REPLACE FUNCTION "pay"."utxo_records_no_delete"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'pay.utxo_records rows are never deleted: a spent output stays as a record.'
    USING ERRCODE = 'restrict_violation';
END;
$$;
DROP TRIGGER IF EXISTS "utxo_records_no_delete_trg" ON "pay"."utxo_records";
CREATE TRIGGER "utxo_records_no_delete_trg"
  BEFORE DELETE ON "pay"."utxo_records"
  FOR EACH ROW EXECUTE FUNCTION "pay"."utxo_records_no_delete"();
