-- NOTIFICATION PREFERENCE HISTORY (M-plat-org-11, J-merchant-01 #6).
--
-- One append-only row for every change a teammate makes to the business's in-app notification preferences: which
-- kind, what it was set to, who changed it and when. `pay.merchant_notification_preferences` keeps the current choice;
-- this table answers "who turned that off?". Changes made before this migration are not here: the current row's
-- `updated_by` is the only record of them. In-app records only, not money.

CREATE TABLE IF NOT EXISTS "pay"."merchant_notification_preference_events" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "seq"         bigserial NOT NULL,
  "merchant_id" uuid NOT NULL REFERENCES "pay"."merchants"("id"),
  "kind"        text NOT NULL,
  "in_app"      boolean NOT NULL,
  "threshold"   text CONSTRAINT "merchant_notification_preference_events_threshold_ck" CHECK ("threshold" IS NULL OR "threshold" ~ '^[0-9]+(\.[0-9]{1,18})?$'),
  "actor_id"    text NOT NULL CONSTRAINT "merchant_notification_preference_events_actor_not_blank" CHECK (length(btrim("actor_id")) > 0),
  "created_at"  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "merchant_notification_preference_events_seq_idx" ON "pay"."merchant_notification_preference_events" ("seq");
CREATE INDEX IF NOT EXISTS "merchant_notification_preference_events_merchant_idx" ON "pay"."merchant_notification_preference_events" ("merchant_id", "seq" DESC);

CREATE OR REPLACE FUNCTION "pay"."merchant_notification_preference_events_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'pay.merchant_notification_preference_events is append-only: % is not permitted. Record a new event instead.', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS "merchant_notification_preference_events_append_only_trg" ON "pay"."merchant_notification_preference_events";
CREATE TRIGGER "merchant_notification_preference_events_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pay"."merchant_notification_preference_events"
  FOR EACH ROW EXECUTE FUNCTION "pay"."merchant_notification_preference_events_append_only"();
