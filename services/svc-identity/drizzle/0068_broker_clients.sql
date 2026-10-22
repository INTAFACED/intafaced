-- Broker / DMA client links (RC-identity-09, TRD-0038). The client accepts the link, so a broker cannot attach itself.
-- Commission schedules are owner-set rows, append-only versions (a trigger refuses UPDATE and DELETE); allocations
-- record the instruction only (execution stays in svc-trade). Every link change writes a history row. No ledger.
-- Reversal: 0068_broker_clients.down.sql

CREATE TABLE IF NOT EXISTS "identity"."broker_clients" (
  "org_id" uuid NOT NULL REFERENCES "identity"."organizations" ("id") ON DELETE CASCADE,
  "client_user_id" uuid NOT NULL REFERENCES "identity"."users" ("id") ON DELETE CASCADE,
  "client_tag" text NOT NULL CHECK (char_length(btrim("client_tag")) BETWEEN 1 AND 64),
  "status" text NOT NULL CHECK ("status" IN ('invited', 'active', 'revoked')),
  -- Organisation segregated accounts do not exist yet; the column stays null until they do.
  "segregated_account_id" uuid,
  "invited_by" uuid NOT NULL,
  "invited_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  "updated_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY ("org_id", "client_user_id")
);
CREATE INDEX IF NOT EXISTS "broker_clients_client_idx" ON "identity"."broker_clients" ("client_user_id");

CREATE TABLE IF NOT EXISTS "identity"."broker_client_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL,
  "client_user_id" uuid NOT NULL,
  "event" text NOT NULL CHECK ("event" IN ('invited', 'accepted', 'revoked')),
  "actor_id" uuid NOT NULL,
  "at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY ("org_id", "client_user_id") REFERENCES "identity"."broker_clients" ("org_id", "client_user_id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "broker_client_events_link_idx" ON "identity"."broker_client_events" ("org_id", "client_user_id", "at");

CREATE TABLE IF NOT EXISTS "identity"."broker_commission_schedules" (
  "org_id" uuid NOT NULL REFERENCES "identity"."organizations" ("id") ON DELETE CASCADE,
  "version" integer NOT NULL CHECK ("version" >= 1),
  "rows" jsonb NOT NULL,
  "published_by" uuid NOT NULL,
  "published_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY ("org_id", "version")
);
CREATE OR REPLACE FUNCTION "identity"."broker_commission_schedules_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'identity.broker_schedule_immutable' USING ERRCODE = 'check_violation';
END;
$$;
DROP TRIGGER IF EXISTS "broker_commission_schedules_immutable" ON "identity"."broker_commission_schedules";
CREATE TRIGGER "broker_commission_schedules_immutable" BEFORE UPDATE OR DELETE ON "identity"."broker_commission_schedules"
  FOR EACH ROW EXECUTE FUNCTION "identity"."broker_commission_schedules_immutable"();

CREATE TABLE IF NOT EXISTS "identity"."broker_allocations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL,
  "client_user_id" uuid NOT NULL,
  "instruction_hash" text NOT NULL,
  "instruction" jsonb NOT NULL,
  "allocated_by" uuid NOT NULL,
  "allocated_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY ("org_id", "client_user_id") REFERENCES "identity"."broker_clients" ("org_id", "client_user_id") ON DELETE CASCADE,
  UNIQUE ("org_id", "client_user_id", "instruction_hash")
);
