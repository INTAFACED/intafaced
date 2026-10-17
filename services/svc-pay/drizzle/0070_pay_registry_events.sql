-- svc-pay · W16 audit trail for the venue, network and wallet-route registries.
-- Reversal: 0070_pay_registry_events.down.sql
--
-- One row per change: who (founder id), who approved it when dual control was
-- required, and the whole entry before and after. Append-only: a wrong change
-- is corrected by a new change, never by editing history. No credential is ever
-- in `before` or `after`, because the registries have none to hold.

CREATE TABLE IF NOT EXISTS "pay"."registry_events" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "seq"          bigserial NOT NULL,
  "registry"     text NOT NULL,
  "entry_key"    text NOT NULL,
  "action"       text NOT NULL,
  "actor_id"     text NOT NULL,
  "approver_id"  text,
  "dual_control" boolean NOT NULL,
  "before"       jsonb,
  "after"        jsonb NOT NULL,
  "reason"       text NOT NULL,
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "registry_events_registry_known" CHECK ("registry" IN ('venue', 'network', 'wallet_route')),
  CONSTRAINT "registry_events_action_known" CHECK ("action" IN ('create', 'update')),
  CONSTRAINT "registry_events_key_not_blank" CHECK (length(btrim("entry_key")) > 0),
  CONSTRAINT "registry_events_actor_not_blank" CHECK (length(btrim("actor_id")) > 0),
  CONSTRAINT "registry_events_reason_not_blank" CHECK (length(btrim("reason")) > 0),
  CONSTRAINT "registry_events_dual_has_approver" CHECK (
    NOT "dual_control" OR (
      "approver_id" IS NOT NULL AND length(btrim("approver_id")) > 0 AND lower("approver_id") <> lower("actor_id")
    )
  ),
  CONSTRAINT "registry_events_create_has_no_before" CHECK (("action" = 'create') = ("before" IS NULL))
);

CREATE INDEX IF NOT EXISTS "registry_events_entry_idx"
  ON "pay"."registry_events" ("registry", "entry_key", "seq" DESC);

CREATE OR REPLACE FUNCTION "pay"."registry_events_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'pay.registry_events is append-only: % is not permitted. Correct with a new change, do not edit the old one.', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS "registry_events_append_only_trg" ON "pay"."registry_events";
CREATE TRIGGER "registry_events_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pay"."registry_events"
  FOR EACH ROW EXECUTE FUNCTION "pay"."registry_events_append_only"();
