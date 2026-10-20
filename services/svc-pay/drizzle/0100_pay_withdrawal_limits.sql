-- svc-pay · W-withdraw-05 owner-set withdrawal limits per KYC tier and asset (D-148).
-- Reversal: 0100_pay_withdrawal_limits.down.sql
--
-- DATA, NOT CONFIG. The withdrawal guard (src/limits/guards.ts) reads these rows
-- inside the transaction that claims a withdrawal. A founder edits them through
-- `founderAdmin.limits.change`; setting or raising a figure needs a second founder.
--
-- BLANK IS REFUSED. No row is seeded and the figures have no default. A row whose
-- figures are NULL is "cleared": the guard reads it exactly like a missing row and
-- refuses the withdrawal (`pay.guard_withdrawal_limit_unset`). Zero is never
-- unlimited: both figures must be strictly positive when present.

CREATE TABLE IF NOT EXISTS "pay"."withdrawal_limits" (
  "tier"        text NOT NULL,
  "asset_id"    text NOT NULL,
  "per_tx"      text,
  "rolling_24h" text,
  "version"     integer NOT NULL DEFAULT 1,
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "updated_at"  timestamptz NOT NULL DEFAULT now(),
  "updated_by"  text NOT NULL,
  PRIMARY KEY ("tier", "asset_id"),
  CONSTRAINT "withdrawal_limits_tier_known" CHECK ("tier" IN ('none', 'basic', 'full', 'institutional')),
  CONSTRAINT "withdrawal_limits_asset_not_blank" CHECK (length(btrim("asset_id")) > 0),
  CONSTRAINT "withdrawal_limits_both_or_neither" CHECK (("per_tx" IS NULL) = ("rolling_24h" IS NULL)),
  CONSTRAINT "withdrawal_limits_per_tx_decimal" CHECK ("per_tx" IS NULL OR ("per_tx" ~ '^[0-9]+(\.[0-9]{1,18})?$' AND "per_tx"::numeric > 0)),
  CONSTRAINT "withdrawal_limits_rolling_decimal" CHECK ("rolling_24h" IS NULL OR ("rolling_24h" ~ '^[0-9]+(\.[0-9]{1,18})?$' AND "rolling_24h"::numeric > 0)),
  CONSTRAINT "withdrawal_limits_per_tx_within_rolling" CHECK ("per_tx" IS NULL OR "per_tx"::numeric <= "rolling_24h"::numeric),
  CONSTRAINT "withdrawal_limits_version_positive" CHECK ("version" >= 1),
  CONSTRAINT "withdrawal_limits_updated_by_not_blank" CHECK (length(btrim("updated_by")) > 0)
);

-- One row per change: who proposed it, who approved it when a second founder was
-- required, and the figures before and after (NULL = no limit set). Append-only.
CREATE TABLE IF NOT EXISTS "pay"."withdrawal_limit_events" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "seq"          bigserial NOT NULL,
  "tier"         text NOT NULL,
  "asset_id"     text NOT NULL,
  "action"       text NOT NULL,
  "actor_id"     text NOT NULL,
  "approver_id"  text,
  "dual_control" boolean NOT NULL,
  "before"       jsonb,
  "after"        jsonb,
  "reason"       text NOT NULL,
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "withdrawal_limit_events_action_known" CHECK ("action" IN ('set', 'clear')),
  CONSTRAINT "withdrawal_limit_events_actor_not_blank" CHECK (length(btrim("actor_id")) > 0),
  CONSTRAINT "withdrawal_limit_events_reason_not_blank" CHECK (length(btrim("reason")) > 0),
  CONSTRAINT "withdrawal_limit_events_clear_has_no_after" CHECK (("action" = 'clear') = ("after" IS NULL)),
  CONSTRAINT "withdrawal_limit_events_dual_has_approver" CHECK (
    NOT "dual_control" OR (
      "approver_id" IS NOT NULL AND length(btrim("approver_id")) > 0 AND lower("approver_id") <> lower("actor_id")
    )
  )
);

CREATE INDEX IF NOT EXISTS "withdrawal_limit_events_entry_idx"
  ON "pay"."withdrawal_limit_events" ("tier", "asset_id", "seq" DESC);

CREATE OR REPLACE FUNCTION "pay"."withdrawal_limit_events_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'pay.withdrawal_limit_events is append-only: % is not permitted. Correct with a new change, do not edit the old one.', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS "withdrawal_limit_events_append_only_trg" ON "pay"."withdrawal_limit_events";
CREATE TRIGGER "withdrawal_limit_events_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pay"."withdrawal_limit_events"
  FOR EACH ROW EXECUTE FUNCTION "pay"."withdrawal_limit_events_append_only"();
