-- svc-pay · W-custody-ops-01 custody account model: entities, vault accounts, wallets, and their history.
-- Reversal: 0104_pay_custody_accounts.down.sql
--
-- NOTHING HERE HOLDS A BALANCE. The ledger is the only book (AGENTS.md money rule 1). These rows say who owns a
-- vault and which network and asset a wallet is for; an address is filled in later by address assignment
-- (W-custody-ops-03), so until then a wallet is "requested" and has no address. A vault is hidden or renamed,
-- never deleted: no delete path, and the history is append-only.

CREATE TABLE IF NOT EXISTS "pay"."custody_entities" (
  "entity_id"    text PRIMARY KEY,
  "display_name" text NOT NULL,
  "ownership"    text NOT NULL,
  "environment"  text NOT NULL,
  "customer_ref" text,
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  "created_by"   text NOT NULL,
  CONSTRAINT "custody_entities_id_shape" CHECK ("entity_id" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length("entity_id") <= 64),
  CONSTRAINT "custody_entities_name_not_blank" CHECK (length(btrim("display_name")) > 0),
  CONSTRAINT "custody_entities_ownership_known" CHECK ("ownership" IN ('entity_owned', 'customer_attributed')),
  CONSTRAINT "custody_entities_environment_known" CHECK ("environment" IN ('sandbox', 'testnet', 'mainnet')),
  CONSTRAINT "custody_entities_customer_ref_ck" CHECK (
    ("ownership" = 'customer_attributed' AND "customer_ref" IS NOT NULL AND length(btrim("customer_ref")) > 0)
    OR ("ownership" = 'entity_owned' AND "customer_ref" IS NULL)
  ),
  CONSTRAINT "custody_entities_created_by_not_blank" CHECK (length(btrim("created_by")) > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS "custody_entities_customer_env_uq" ON "pay"."custody_entities" ("customer_ref", "environment")
  WHERE "customer_ref" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "pay"."custody_vaults" (
  "vault_id"   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "entity_id"  text NOT NULL REFERENCES "pay"."custody_entities" ("entity_id"),
  "client_ref" text NOT NULL,
  "name"       text NOT NULL,
  "hidden"     boolean NOT NULL DEFAULT false,
  "version"    integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "created_by" text NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "updated_by" text NOT NULL,
  CONSTRAINT "custody_vaults_client_ref_shape" CHECK ("client_ref" ~ '^[A-Za-z0-9:_.-]{1,128}$'),
  CONSTRAINT "custody_vaults_name_not_blank" CHECK (length(btrim("name")) > 0),
  CONSTRAINT "custody_vaults_version_positive" CHECK ("version" >= 1),
  CONSTRAINT "custody_vaults_actor_not_blank" CHECK (length(btrim("created_by")) > 0 AND length(btrim("updated_by")) > 0),
  CONSTRAINT "custody_vaults_entity_ref_uq" UNIQUE ("entity_id", "client_ref")
);
CREATE UNIQUE INDEX IF NOT EXISTS "custody_vaults_entity_name_uq" ON "pay"."custody_vaults" ("entity_id", lower(btrim("name")));
CREATE INDEX IF NOT EXISTS "custody_vaults_entity_idx" ON "pay"."custody_vaults" ("entity_id", "vault_id");

CREATE TABLE IF NOT EXISTS "pay"."custody_wallets" (
  "wallet_id"  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "vault_id"   uuid NOT NULL REFERENCES "pay"."custody_vaults" ("vault_id"),
  "network_id" text NOT NULL REFERENCES "pay"."network_registry" ("network_id"),
  "asset_code" text NOT NULL,
  "address"    text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "created_by" text NOT NULL,
  CONSTRAINT "custody_wallets_asset_shape" CHECK ("asset_code" ~ '^[A-Z0-9]{1,16}$'),
  CONSTRAINT "custody_wallets_address_not_blank" CHECK ("address" IS NULL OR length(btrim("address")) > 0),
  CONSTRAINT "custody_wallets_created_by_not_blank" CHECK (length(btrim("created_by")) > 0),
  CONSTRAINT "custody_wallets_vault_asset_uq" UNIQUE ("vault_id", "network_id", "asset_code")
);
CREATE UNIQUE INDEX IF NOT EXISTS "custody_wallets_address_uq" ON "pay"."custody_wallets" ("network_id", "address")
  WHERE "address" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "pay"."custody_events" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "seq"          bigserial NOT NULL,
  "subject_kind" text NOT NULL,
  "subject_id"   text NOT NULL,
  "action"       text NOT NULL,
  "actor_id"     text NOT NULL,
  "detail"       jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "custody_events_kind_known" CHECK ("subject_kind" IN ('entity', 'vault', 'wallet')),
  CONSTRAINT "custody_events_action_known" CHECK ("action" IN ('create', 'rename', 'hide', 'unhide')),
  CONSTRAINT "custody_events_actor_not_blank" CHECK (length(btrim("actor_id")) > 0)
);
CREATE INDEX IF NOT EXISTS "custody_events_subject_idx" ON "pay"."custody_events" ("subject_kind", "subject_id", "seq" DESC);

CREATE OR REPLACE FUNCTION "pay"."custody_events_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'pay.custody_events is append-only: % is not permitted. Record a new event instead.', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS "custody_events_append_only_trg" ON "pay"."custody_events";
CREATE TRIGGER "custody_events_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pay"."custody_events"
  FOR EACH ROW EXECUTE FUNCTION "pay"."custody_events_append_only"();

-- A vault is never deleted: hide it instead.
CREATE OR REPLACE FUNCTION "pay"."custody_vaults_no_delete"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'pay.custody_vaults rows are never deleted: hide the vault instead.'
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS "custody_vaults_no_delete_trg" ON "pay"."custody_vaults";
CREATE TRIGGER "custody_vaults_no_delete_trg"
  BEFORE DELETE ON "pay"."custody_vaults"
  FOR EACH ROW EXECUTE FUNCTION "pay"."custody_vaults_no_delete"();
