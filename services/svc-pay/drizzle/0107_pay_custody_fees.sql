-- Network fee settings and gas policy (W-custody-ops-10, wallet-custody-ops-051/052/072/073). Settings only: no balance
-- lives here (a tank balance is read from the chain or the ledger, never kept), and nothing is sent. Every table is
-- append-only: the latest row for a network is its setting, and the older rows are the history. A network with no row
-- has no setting, and a send that needs a fee cap refuses rather than guessing one.
CREATE TABLE IF NOT EXISTS "pay"."network_fee_settings_events" (
  "seq" bigserial PRIMARY KEY,
  "network_id" text NOT NULL,
  "fee_level" text NOT NULL,
  "fee_cap" numeric(38,18) NOT NULL,
  "fee_unit" text NOT NULL,
  "managed_nonce" boolean NOT NULL,
  "reason" text NOT NULL,
  "set_by" text NOT NULL,
  "set_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "network_fee_settings_level_ck" CHECK ("fee_level" IN ('low', 'medium', 'high')),
  CONSTRAINT "network_fee_settings_cap_positive" CHECK ("fee_cap" > 0),
  CONSTRAINT "network_fee_settings_text_ck" CHECK (length(btrim("network_id")) > 0 AND length(btrim("fee_unit")) > 0
    AND length(btrim("reason")) > 0 AND length(btrim("set_by")) > 0)
);
CREATE INDEX IF NOT EXISTS "network_fee_settings_network_idx" ON "pay"."network_fee_settings_events" ("network_id", "seq" DESC);

CREATE TABLE IF NOT EXISTS "pay"."gas_policy_events" (
  "seq" bigserial PRIMARY KEY,
  "network_id" text NOT NULL,
  "fee_payer" text NOT NULL,
  "gas_threshold" numeric(38,18) NOT NULL,
  "gas_cap" numeric(38,18) NOT NULL,
  "max_gas_price" numeric(38,18) NOT NULL,
  "auto_top_up" boolean NOT NULL,
  "reason" text NOT NULL,
  "set_by" text NOT NULL,
  "set_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "gas_policy_payer_ck" CHECK ("fee_payer" IN ('self', 'station', 'relay')),
  CONSTRAINT "gas_policy_amounts_positive" CHECK ("gas_threshold" > 0 AND "gas_cap" > 0 AND "max_gas_price" > 0),
  CONSTRAINT "gas_policy_text_ck" CHECK (length(btrim("network_id")) > 0 AND length(btrim("reason")) > 0 AND length(btrim("set_by")) > 0)
);
CREATE INDEX IF NOT EXISTS "gas_policy_network_idx" ON "pay"."gas_policy_events" ("network_id", "seq" DESC);

-- A refuel done elsewhere, written down. Recording one moves nothing.
CREATE TABLE IF NOT EXISTS "pay"."gas_refuels" (
  "seq" bigserial PRIMARY KEY,
  "refuel_ref" text NOT NULL,
  "network_id" text NOT NULL,
  "amount" numeric(38,18) NOT NULL,
  "tx_ref" text NOT NULL,
  "reason" text NOT NULL,
  "recorded_by" text NOT NULL,
  "recorded_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "gas_refuels_amount_positive" CHECK ("amount" > 0),
  CONSTRAINT "gas_refuels_text_ck" CHECK (length(btrim("refuel_ref")) > 0 AND length(btrim("network_id")) > 0
    AND length(btrim("tx_ref")) > 0 AND length(btrim("reason")) > 0 AND length(btrim("recorded_by")) > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS "gas_refuels_ref_uq" ON "pay"."gas_refuels" ("refuel_ref");
CREATE INDEX IF NOT EXISTS "gas_refuels_network_idx" ON "pay"."gas_refuels" ("network_id", "seq" DESC);

CREATE OR REPLACE FUNCTION "pay"."custody_fees_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on pay.% is not permitted: fee settings, gas policy and refuels are never edited or deleted. Record a new row instead.', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS "network_fee_settings_append_only_trg" ON "pay"."network_fee_settings_events";
CREATE TRIGGER "network_fee_settings_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pay"."network_fee_settings_events"
  FOR EACH ROW EXECUTE FUNCTION "pay"."custody_fees_append_only"();

DROP TRIGGER IF EXISTS "gas_policy_append_only_trg" ON "pay"."gas_policy_events";
CREATE TRIGGER "gas_policy_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pay"."gas_policy_events"
  FOR EACH ROW EXECUTE FUNCTION "pay"."custody_fees_append_only"();

DROP TRIGGER IF EXISTS "gas_refuels_append_only_trg" ON "pay"."gas_refuels";
CREATE TRIGGER "gas_refuels_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pay"."gas_refuels"
  FOR EACH ROW EXECUTE FUNCTION "pay"."custody_fees_append_only"();
