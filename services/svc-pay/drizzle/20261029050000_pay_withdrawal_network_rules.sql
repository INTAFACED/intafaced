-- Reversal: 20261029050000_pay_withdrawal_network_rules.down.sql
-- The owner's withdrawal rules per asset and network (W-withdraw-02, J-wallet-05 #1): the smallest and largest amount one
-- withdrawal may send, the step an amount must be a whole multiple of, and whether the network takes a tag or memo. A pair
-- with no row has no rules, and a quote on it is refused (`withdrawal_quote.rules_unset`). NO BALANCE LIVES HERE, nothing
-- has a default, and this migration inserts no row: every figure in a row is the owner's, or the stack's labelled TEST value.
CREATE TABLE IF NOT EXISTS "pay"."withdrawal_network_rules" (
  "asset_id" text NOT NULL,
  "network_id" text NOT NULL,
  "minimum" text NOT NULL,
  "maximum" text NOT NULL,
  "step" text NOT NULL,
  "tag" text NOT NULL,
  "version" integer NOT NULL DEFAULT 1,
  "set_by" text NOT NULL,
  "set_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("asset_id", "network_id"),
  CONSTRAINT "withdrawal_network_rules_ids_ck" CHECK ("asset_id" ~ '^[A-Za-z0-9]{1,16}$' AND "network_id" ~ '^[A-Za-z0-9_-]{1,32}$'),
  CONSTRAINT "withdrawal_network_rules_amounts_ck" CHECK (
    "minimum" ~ '^(0|[1-9][0-9]{0,29})(\.[0-9]{1,18})?$' AND "maximum" ~ '^(0|[1-9][0-9]{0,29})(\.[0-9]{1,18})?$'
    AND "step" ~ '^(0|[1-9][0-9]{0,29})(\.[0-9]{1,18})?$'
    AND "step"::numeric > 0 AND "minimum"::numeric >= "step"::numeric AND "maximum"::numeric >= "minimum"::numeric
  ),
  CONSTRAINT "withdrawal_network_rules_tag_ck" CHECK ("tag" IN ('none', 'required')),
  CONSTRAINT "withdrawal_network_rules_version_ck" CHECK ("version" >= 1),
  CONSTRAINT "withdrawal_network_rules_set_by_ck" CHECK (length(btrim("set_by")) > 0)
);

-- Every change, with who proposed it and who approved it. Append-only.
CREATE TABLE IF NOT EXISTS "pay"."withdrawal_network_rule_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "seq" bigserial NOT NULL,
  "asset_id" text NOT NULL,
  "network_id" text NOT NULL,
  "action" text NOT NULL,
  "actor_id" text NOT NULL,
  "approver_id" text,
  "dual_control" boolean NOT NULL,
  "before" jsonb,
  "after" jsonb NOT NULL,
  "reason" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "withdrawal_network_rule_events_action_ck" CHECK ("action" IN ('create', 'update')),
  CONSTRAINT "withdrawal_network_rule_events_actor_ck" CHECK (length(btrim("actor_id")) > 0),
  CONSTRAINT "withdrawal_network_rule_events_reason_ck" CHECK (length(btrim("reason")) > 0),
  CONSTRAINT "withdrawal_network_rule_events_dual_ck" CHECK (
    NOT "dual_control" OR ("approver_id" IS NOT NULL AND length(btrim("approver_id")) > 0 AND lower("approver_id") <> lower("actor_id"))
  ),
  CONSTRAINT "withdrawal_network_rule_events_create_ck" CHECK (("action" = 'create') = ("before" IS NULL))
);
CREATE INDEX IF NOT EXISTS "withdrawal_network_rule_events_pair_idx"
  ON "pay"."withdrawal_network_rule_events" ("asset_id", "network_id", "seq" DESC);

CREATE OR REPLACE FUNCTION "pay"."withdrawal_network_rule_events_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'pay.withdrawal_network_rule_events is append-only';
END;
$$;
DROP TRIGGER IF EXISTS "withdrawal_network_rule_events_append_only_trg" ON "pay"."withdrawal_network_rule_events";
CREATE TRIGGER "withdrawal_network_rule_events_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pay"."withdrawal_network_rule_events"
  FOR EACH ROW EXECUTE FUNCTION "pay"."withdrawal_network_rule_events_append_only"();
