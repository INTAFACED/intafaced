-- Outbound travel rule (W-compliance-notices-04, wallet-compliance-notices-035, -040 and -042). Four append-only
-- groups: the owner's applicability rules and wait limits (the latest row per key is the setting, none means blank and
-- refuses), one transfer record per withdrawal with its transitions (status is the latest transition), and the
-- encrypted IVMS101-shaped messages linked to a transfer. Nothing here moves money or holds a balance. A transfer can
-- reach `accepted` or `completed` only from a counterparty reply or the system, never from an operator, and a wait
-- that runs out is a status that keeps blocking: a timer never approves.
CREATE TABLE IF NOT EXISTS "pay"."travel_rule_rule_events" (
  "seq" bigserial PRIMARY KEY,
  "region" text NOT NULL,
  "entity" text NOT NULL,
  "asset_id" text NOT NULL,
  "applies" boolean NOT NULL,
  "threshold" numeric(38,18),
  "fields" jsonb NOT NULL,
  "reason" text NOT NULL,
  "set_by" text NOT NULL,
  "set_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "travel_rule_rule_region_ck" CHECK ("region" = '*' OR "region" ~ '^[A-Z]{2}(-[A-Z0-9]{1,3})?$'),
  CONSTRAINT "travel_rule_rule_entity_ck" CHECK ("entity" IN ('individual', 'business')),
  CONSTRAINT "travel_rule_rule_threshold_ck" CHECK (
    ("applies" AND "threshold" IS NOT NULL AND "threshold" >= 0) OR (NOT "applies" AND "threshold" IS NULL)
  ),
  CONSTRAINT "travel_rule_rule_fields_array" CHECK (jsonb_typeof("fields") = 'array'),
  CONSTRAINT "travel_rule_rule_fields_when_applies" CHECK (NOT "applies" OR jsonb_array_length("fields") > 0),
  CONSTRAINT "travel_rule_rule_text_ck" CHECK (length(btrim("asset_id")) > 0 AND length(btrim("reason")) > 0
    AND length(btrim("set_by")) > 0)
);
CREATE INDEX IF NOT EXISTS "travel_rule_rule_key_idx" ON "pay"."travel_rule_rule_events" ("region", "entity", "asset_id", "seq" DESC);

CREATE TABLE IF NOT EXISTS "pay"."travel_rule_wait_limit_events" (
  "seq" bigserial PRIMARY KEY,
  "pending_seconds" integer NOT NULL,
  "repair_seconds" integer NOT NULL,
  "set_by" text NOT NULL,
  "set_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "travel_rule_wait_pending_positive" CHECK ("pending_seconds" > 0),
  CONSTRAINT "travel_rule_wait_repair_positive" CHECK ("repair_seconds" > 0),
  CONSTRAINT "travel_rule_wait_actor_not_blank" CHECK (length(btrim("set_by")) > 0)
);

CREATE TABLE IF NOT EXISTS "pay"."travel_rule_transfers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "withdrawal_id" uuid NOT NULL REFERENCES "pay"."withdrawals" ("id"),
  "user_id" text NOT NULL,
  "asset_id" text NOT NULL,
  "network_id" text NOT NULL,
  "amount" numeric(38,18) NOT NULL,
  "region" text NOT NULL,
  "entity" text NOT NULL,
  "assessment" text NOT NULL,
  "rule_seq" bigint NOT NULL REFERENCES "pay"."travel_rule_rule_events" ("seq"),
  "required_fields" jsonb NOT NULL,
  "opened_by" text NOT NULL,
  "opened_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "travel_rule_transfers_amount_positive" CHECK ("amount" > 0),
  CONSTRAINT "travel_rule_transfers_assessment_ck" CHECK ("assessment" IN ('required', 'not_required')),
  CONSTRAINT "travel_rule_transfers_entity_ck" CHECK ("entity" IN ('individual', 'business'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "travel_rule_transfers_withdrawal_uq" ON "pay"."travel_rule_transfers" ("withdrawal_id");

CREATE TABLE IF NOT EXISTS "pay"."travel_rule_transitions" (
  "seq" bigserial PRIMARY KEY,
  "transfer_id" uuid NOT NULL REFERENCES "pay"."travel_rule_transfers" ("id"),
  "from_status" text,
  "to_status" text NOT NULL,
  "source" text NOT NULL,
  "actor" text NOT NULL,
  "reason" text,
  "wait_deadline" timestamptz,
  "at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "travel_rule_transitions_status_ck" CHECK ("to_status" IN (
    'started', 'pending', 'review', 'repair', 'accepted', 'completed', 'rejected', 'not_required',
    'provider_unavailable', 'blocking_time_expired', 'canceled', 'failed'
  )),
  CONSTRAINT "travel_rule_transitions_source_ck" CHECK ("source" IN ('system', 'counterparty', 'operator')),
  CONSTRAINT "travel_rule_transitions_actor_not_blank" CHECK (length(btrim("actor")) > 0)
);
CREATE INDEX IF NOT EXISTS "travel_rule_transitions_transfer_idx" ON "pay"."travel_rule_transitions" ("transfer_id", "seq" DESC);

CREATE TABLE IF NOT EXISTS "pay"."travel_rule_messages" (
  "seq" bigserial PRIMARY KEY,
  "transfer_id" uuid NOT NULL REFERENCES "pay"."travel_rule_transfers" ("id"),
  "direction" text NOT NULL DEFAULT 'outgoing',
  "key_id" text NOT NULL,
  "iv" bytea NOT NULL,
  "auth_tag" bytea NOT NULL,
  "ciphertext" bytea NOT NULL,
  "missing_fields" jsonb NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "travel_rule_messages_direction_ck" CHECK ("direction" = 'outgoing'),
  CONSTRAINT "travel_rule_messages_shape_ck" CHECK (length("iv") = 12 AND length("auth_tag") = 16 AND length("ciphertext") > 0)
);
CREATE INDEX IF NOT EXISTS "travel_rule_messages_transfer_idx" ON "pay"."travel_rule_messages" ("transfer_id", "seq" DESC);

CREATE OR REPLACE FUNCTION "pay"."travel_rule_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on pay.% is not permitted: travel-rule rules, limits, transfers, transitions and messages are never edited or deleted.', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS "travel_rule_rule_events_append_only_trg" ON "pay"."travel_rule_rule_events";
CREATE TRIGGER "travel_rule_rule_events_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pay"."travel_rule_rule_events"
  FOR EACH ROW EXECUTE FUNCTION "pay"."travel_rule_append_only"();
DROP TRIGGER IF EXISTS "travel_rule_wait_limit_events_append_only_trg" ON "pay"."travel_rule_wait_limit_events";
CREATE TRIGGER "travel_rule_wait_limit_events_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pay"."travel_rule_wait_limit_events"
  FOR EACH ROW EXECUTE FUNCTION "pay"."travel_rule_append_only"();
DROP TRIGGER IF EXISTS "travel_rule_transfers_append_only_trg" ON "pay"."travel_rule_transfers";
CREATE TRIGGER "travel_rule_transfers_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pay"."travel_rule_transfers"
  FOR EACH ROW EXECUTE FUNCTION "pay"."travel_rule_append_only"();
DROP TRIGGER IF EXISTS "travel_rule_transitions_append_only_trg" ON "pay"."travel_rule_transitions";
CREATE TRIGGER "travel_rule_transitions_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pay"."travel_rule_transitions"
  FOR EACH ROW EXECUTE FUNCTION "pay"."travel_rule_append_only"();
DROP TRIGGER IF EXISTS "travel_rule_messages_append_only_trg" ON "pay"."travel_rule_messages";
CREATE TRIGGER "travel_rule_messages_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pay"."travel_rule_messages"
  FOR EACH ROW EXECUTE FUNCTION "pay"."travel_rule_append_only"();
