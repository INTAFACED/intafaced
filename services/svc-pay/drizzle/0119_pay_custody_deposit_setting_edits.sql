-- Owner edits of the customer deposit settings (W-deposit-04). Adds an optimistic version and the halt note shown to customers when
-- a pair is switched off, and an append-only audit of every change with who proposed it and who approved it. No row is inserted:
-- a pair with no setting stays out of the catalogue (nothing has a default).
ALTER TABLE "pay"."custody_deposit_settings" ADD COLUMN IF NOT EXISTS "version" integer NOT NULL DEFAULT 1;
ALTER TABLE "pay"."custody_deposit_settings" ADD COLUMN IF NOT EXISTS "halt_note" text;
ALTER TABLE "pay"."custody_deposit_settings"
  ADD CONSTRAINT "custody_deposit_settings_halt_note_ck" CHECK ("halt_note" IS NULL OR length(btrim("halt_note")) BETWEEN 1 AND 280);

CREATE TABLE IF NOT EXISTS "pay"."custody_deposit_setting_events" (
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
  CONSTRAINT "custody_deposit_setting_events_action_ck" CHECK ("action" IN ('create', 'update')),
  CONSTRAINT "custody_deposit_setting_events_actor_ck" CHECK (length(btrim("actor_id")) > 0),
  CONSTRAINT "custody_deposit_setting_events_reason_ck" CHECK (length(btrim("reason")) > 0),
  CONSTRAINT "custody_deposit_setting_events_dual_ck" CHECK (
    NOT "dual_control" OR ("approver_id" IS NOT NULL AND length(btrim("approver_id")) > 0 AND lower("approver_id") <> lower("actor_id"))
  ),
  CONSTRAINT "custody_deposit_setting_events_create_ck" CHECK (("action" = 'create') = ("before" IS NULL))
);
CREATE INDEX IF NOT EXISTS "custody_deposit_setting_events_pair_idx"
  ON "pay"."custody_deposit_setting_events" ("asset_id", "network_id", "seq" DESC);

CREATE OR REPLACE FUNCTION "pay"."custody_deposit_setting_events_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'pay.custody_deposit_setting_events is append-only';
END;
$$;
DROP TRIGGER IF EXISTS "custody_deposit_setting_events_append_only_trg" ON "pay"."custody_deposit_setting_events";
CREATE TRIGGER "custody_deposit_setting_events_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pay"."custody_deposit_setting_events"
  FOR EACH ROW EXECUTE FUNCTION "pay"."custody_deposit_setting_events_append_only"();
