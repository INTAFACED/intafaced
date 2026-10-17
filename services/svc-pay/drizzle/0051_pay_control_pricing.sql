-- W1 MERCHANT CONTROL ROOM (2/5): pricing rules and per-payment/settlement snapshots.
--
-- Rules are IMMUTABLE once written (only `superseded_at` may be set), so a
-- snapshot that names a rule id can always be recomputed from it. Rule layering
-- is global -> tier -> merchant; the most specific layer that has a rule for the
-- asset wins as a whole. No rule is seeded: no rule means refuse.

CREATE TABLE IF NOT EXISTS "pay"."control_pricing_rules" (
  "id"                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "layer"                 text NOT NULL CONSTRAINT "control_pricing_layer_known" CHECK ("layer" IN ('global', 'tier', 'merchant')),
  -- '' for global, a tier id for tier, a merchant id for merchant.
  "scope_id"              text NOT NULL,
  "asset_code"            text NOT NULL CONSTRAINT "control_pricing_asset_not_blank" CHECK (length(btrim("asset_code")) > 0),
  "bands"                 jsonb NOT NULL CONSTRAINT "control_pricing_bands_array" CHECK (jsonb_typeof("bands") = 'array' AND jsonb_array_length("bands") > 0),
  "spread_bps"            integer CONSTRAINT "control_pricing_spread_range" CHECK ("spread_bps" IS NULL OR ("spread_bps" >= 0 AND "spread_bps" <= 10000)),
  "rounding_beneficiary"  text NOT NULL CONSTRAINT "control_pricing_rounding_known" CHECK ("rounding_beneficiary" IN ('platform', 'merchant')),
  "min_fee"               numeric(60, 18) CONSTRAINT "control_pricing_min_fee_nonneg" CHECK ("min_fee" IS NULL OR "min_fee" >= 0),
  "max_fee"               numeric(60, 18) CONSTRAINT "control_pricing_max_fee_nonneg" CHECK ("max_fee" IS NULL OR "max_fee" >= 0),
  "version"               bigint NOT NULL,
  "created_by"            text NOT NULL,
  "created_at"            timestamptz NOT NULL DEFAULT now(),
  "superseded_at"         timestamptz,
  CONSTRAINT "control_pricing_scope_matches_layer" CHECK (("layer" = 'global') = ("scope_id" = '')),
  CONSTRAINT "control_pricing_min_le_max" CHECK ("min_fee" IS NULL OR "max_fee" IS NULL OR "min_fee" <= "max_fee")
);

-- One live rule per (layer, scope, asset).
CREATE UNIQUE INDEX IF NOT EXISTS "control_pricing_live_idx"
  ON "pay"."control_pricing_rules" ("layer", "scope_id", "asset_code") WHERE "superseded_at" IS NULL;
CREATE INDEX IF NOT EXISTS "control_pricing_scope_idx" ON "pay"."control_pricing_rules" ("layer", "scope_id", "version" DESC);

CREATE OR REPLACE FUNCTION "pay"."control_pricing_rules_immutable"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."superseded_at" IS NULL AND NEW."superseded_at" IS NOT NULL
     AND (to_jsonb(NEW) - 'superseded_at') = (to_jsonb(OLD) - 'superseded_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'pay.control_pricing_rules is immutable: % is not permitted. Supersede the rule with a new row.', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
DROP TRIGGER IF EXISTS "control_pricing_rules_immutable_trg" ON "pay"."control_pricing_rules";
CREATE TRIGGER "control_pricing_rules_immutable_trg"
  BEFORE UPDATE OR DELETE ON "pay"."control_pricing_rules"
  FOR EACH ROW EXECUTE FUNCTION "pay"."control_pricing_rules_immutable"();

-- What was charged, frozen at the moment it was decided. One row per payment
-- or settlement. `fee` etc. are the engine's computed amounts; `booked_fee` is
-- what the settlement row actually carries (null for payments), so any drift
-- between the engine and the booked fee is visible, not hidden.
CREATE TABLE IF NOT EXISTS "pay"."control_pricing_snapshots" (
  "id"                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "subject_kind"          text NOT NULL CONSTRAINT "control_snapshots_subject_known" CHECK ("subject_kind" IN ('payment', 'settlement')),
  "subject_id"            uuid NOT NULL,
  "merchant_id"           uuid NOT NULL REFERENCES "pay"."merchants"("id"),
  "asset_code"            text NOT NULL,
  "applied_layer"         text NOT NULL,
  "rule_id"               uuid NOT NULL REFERENCES "pay"."control_pricing_rules"("id"),
  "rule_chain"            jsonb NOT NULL,
  "base_amount"           numeric(60, 18) NOT NULL,
  "monthly_volume_before" numeric(60, 18) NOT NULL,
  "band_from"             numeric(60, 18) NOT NULL,
  "fee_bps"               integer NOT NULL,
  "flat_fee"              numeric(60, 18),
  "spread_bps"            integer,
  "rounding_beneficiary"  text NOT NULL,
  "rounding_mode"         text NOT NULL CONSTRAINT "control_snapshots_rounding_mode" CHECK ("rounding_mode" IN ('ceil', 'floor')),
  "bps_fee"               numeric(60, 18) NOT NULL,
  "fee_before_clamp"      numeric(60, 18) NOT NULL,
  "fee"                   numeric(60, 18) NOT NULL,
  "spread"                numeric(60, 18),
  "booked_fee"            numeric(60, 18),
  "reserve_bps"           integer,
  "reserve_hold_days"     integer,
  "reserve_amount"        numeric(60, 18),
  "reserve_release_at"    timestamptz,
  -- 'unwired' until a ledger recipe books it: pay.reserve_ledger_unwired.
  "reserve_ledger_status" text CONSTRAINT "control_snapshots_reserve_status" CHECK ("reserve_ledger_status" IS NULL OR "reserve_ledger_status" IN ('unwired', 'booked')),
  "created_at"            timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "control_snapshots_subject_idx" ON "pay"."control_pricing_snapshots" ("subject_kind", "subject_id");
CREATE INDEX IF NOT EXISTS "control_snapshots_merchant_idx" ON "pay"."control_pricing_snapshots" ("merchant_id", "created_at" DESC);

DROP TRIGGER IF EXISTS "control_snapshots_append_only_trg" ON "pay"."control_pricing_snapshots";
CREATE TRIGGER "control_snapshots_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pay"."control_pricing_snapshots"
  FOR EACH ROW EXECUTE FUNCTION "pay"."control_append_only"();
