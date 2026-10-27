-- W-deposit-07 and W-compliance-notices-05 (J-wallet-03 #1-#3): the inbound travel rule on customer crypto deposits.
-- NO BALANCE LIVES HERE AND NOTHING IS POSTED BY A HOLD. The owner decides, per asset, whether the travel rule applies to an
-- inbound deposit, its threshold and the fields to collect (`travel_rule_inbound_rule_events`, appended, the latest row per asset
-- is the rule). With no rule for the asset a deposit that is otherwise due is not credited: it stays `confirming` with reason
-- `travel_rule_unset`. A deposit at or above the threshold is `held_travel_rule` and is never credited while held. The depositor
-- declares the sending wallet and the asked fields (stored sealed, never in clear); compliance may wait on the counterparty
-- (a wait past its limit stays held: a timer never releases); a founder releases a declared deposit, and it is then credited
-- once under its usual `deposit` key. Every state is a row in `custody_deposit_travel_rule_events`, so the table is the history.
-- Reversal: 20261024204652_pay_custody_deposit_travel_rule.down.sql

CREATE TABLE IF NOT EXISTS "pay"."travel_rule_inbound_rule_events" (
  "seq" bigserial PRIMARY KEY,
  "asset_id" text NOT NULL,
  "applies" boolean NOT NULL,
  "threshold" numeric(38, 18),
  "fields" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "reason" text NOT NULL,
  "set_by" text NOT NULL,
  "set_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "travel_rule_inbound_rule_threshold_ck" CHECK (
    ("applies" AND "threshold" IS NOT NULL AND "threshold" > 0) OR (NOT "applies" AND "threshold" IS NULL)),
  CONSTRAINT "travel_rule_inbound_rule_fields_ck" CHECK (jsonb_typeof("fields") = 'array'),
  CONSTRAINT "travel_rule_inbound_rule_reason_ck" CHECK (length(btrim("reason")) BETWEEN 1 AND 500)
);
CREATE INDEX IF NOT EXISTS "travel_rule_inbound_rule_asset_idx" ON "pay"."travel_rule_inbound_rule_events" ("asset_id", "seq" DESC);

-- One record per held deposit: the rule it was judged by, and the depositor's sealed declaration once given.
CREATE TABLE IF NOT EXISTS "pay"."custody_deposit_travel_rule" (
  "deposit_id" uuid PRIMARY KEY REFERENCES "pay"."custody_deposits" ("id"),
  "user_id" text NOT NULL,
  "rule_seq" bigint NOT NULL REFERENCES "pay"."travel_rule_inbound_rule_events" ("seq"),
  "threshold" numeric(38, 18) NOT NULL,
  "required_fields" jsonb NOT NULL,
  "opened_at" timestamptz NOT NULL DEFAULT now(),
  "wallet_type" text,
  "declaration_key_id" text,
  "declaration_iv" bytea,
  "declaration_auth_tag" bytea,
  "declaration_ciphertext" bytea,
  "declared_at" timestamptz,
  CONSTRAINT "custody_deposit_travel_rule_wallet_ck" CHECK ("wallet_type" IS NULL OR "wallet_type" IN ('exchange', 'self_hosted')),
  CONSTRAINT "custody_deposit_travel_rule_declared_ck" CHECK (
    ("declared_at" IS NULL AND "wallet_type" IS NULL AND "declaration_key_id" IS NULL AND "declaration_iv" IS NULL
      AND "declaration_auth_tag" IS NULL AND "declaration_ciphertext" IS NULL)
    OR ("declared_at" IS NOT NULL AND "wallet_type" IS NOT NULL AND "declaration_key_id" IS NOT NULL AND "declaration_iv" IS NOT NULL
      AND "declaration_auth_tag" IS NOT NULL AND "declaration_ciphertext" IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS "custody_deposit_travel_rule_user_idx" ON "pay"."custody_deposit_travel_rule" ("user_id", "opened_at" DESC);

CREATE TABLE IF NOT EXISTS "pay"."custody_deposit_travel_rule_events" (
  "seq" bigserial PRIMARY KEY,
  "deposit_id" uuid NOT NULL REFERENCES "pay"."custody_deposit_travel_rule" ("deposit_id"),
  "state" text NOT NULL,
  "source" text NOT NULL,
  "actor" text NOT NULL,
  "reason" text,
  "wait_deadline" timestamptz,
  "at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "custody_deposit_travel_rule_events_state_ck" CHECK ("state" IN
    ('awaiting_declaration', 'under_review', 'counterparty_pending', 'blocking_time_expired', 'released')),
  CONSTRAINT "custody_deposit_travel_rule_events_source_ck" CHECK ("source" IN ('system', 'customer', 'operator')),
  CONSTRAINT "custody_deposit_travel_rule_events_wait_ck" CHECK (("state" = 'counterparty_pending') = ("wait_deadline" IS NOT NULL)),
  CONSTRAINT "custody_deposit_travel_rule_events_reason_ck" CHECK ("reason" IS NULL OR length(btrim("reason")) BETWEEN 1 AND 500)
);
CREATE INDEX IF NOT EXISTS "custody_deposit_travel_rule_events_deposit_idx"
  ON "pay"."custody_deposit_travel_rule_events" ("deposit_id", "seq" DESC);

ALTER TABLE "pay"."custody_deposits" DROP CONSTRAINT IF EXISTS "custody_deposits_status_ck";
ALTER TABLE "pay"."custody_deposits" ADD CONSTRAINT "custody_deposits_status_ck" CHECK ("status" IN
  ('detected', 'confirming', 'credited', 'below_minimum', 'held_for_screening', 'held_for_release', 'on_hold', 'held_travel_rule',
   'rejected', 'reversed', 'needs_review'));
ALTER TABLE "pay"."custody_deposits" DROP CONSTRAINT IF EXISTS "custody_deposits_reason_ck";
ALTER TABLE "pay"."custody_deposits" ADD CONSTRAINT "custody_deposits_reason_ck" CHECK ("reason" IS NULL OR "reason" IN
  ('below_minimum', 'amount_mismatch', 'unknown_asset', 'minimum_unset', 'confirmations_unset', 'address_expired', 'chain_reorg',
   'reversal_unfunded', 'address_frozen', 'travel_rule_unset', 'travel_rule_declaration', 'travel_rule_review',
   'travel_rule_counterparty', 'travel_rule_expired'));
-- A deposit held for the travel rule is never credited, and it is held for a travel-rule reason only.
ALTER TABLE "pay"."custody_deposits" DROP CONSTRAINT IF EXISTS "custody_deposits_travel_rule_ck";
ALTER TABLE "pay"."custody_deposits" ADD CONSTRAINT "custody_deposits_travel_rule_ck" CHECK (
  "status" <> 'held_travel_rule' OR (
    "reason" IN ('travel_rule_declaration', 'travel_rule_review', 'travel_rule_counterparty', 'travel_rule_expired')
    AND "credited_at" IS NULL AND "credit_started_at" IS NULL));
