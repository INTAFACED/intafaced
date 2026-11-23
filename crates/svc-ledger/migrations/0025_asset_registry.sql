-- intafaced:destructive TRUNCATE appears only in the BEFORE TRUNCATE guard trigger that refuses truncation; nothing is dropped or deleted
-- svc-ledger · one supported asset and network registry (W-balances-05)
-- Reversal: 0025_asset_registry.down.sql
--
-- Deposit, withdraw and trade each kept their own idea of which assets exist, on
-- which networks and to how many places. `packages/contracts/src/asset-registry.ts`
-- is the one wire shape; this is where its rows live, on the table every balance
-- already has a foreign key to (0006).
--
-- Nothing is defaulted that the owner has not published:
--   · `precision` is NULL until a founder edit sets it. It is NOT copied from
--     `decimals`, which nothing reads (0004's correction): a NULL precision
--     refuses `ledger.asset_precision_unset`, never reads as 18.
--   · `networks` starts empty and `default_network_id` NULL: no network is
--     guessed for an existing asset.
--   · `allowed_actions` starts empty: until an edit names an action, every
--     service that owns that action refuses it for this asset.
--   · `state` follows the existing `active` flag: an inactive asset is halted,
--     never retired and never deleted.
--
-- Edits are founder edits under svc-identity's action approval
-- (`ledger.asset_edit`), applied once per operation id; `asset_edits` keeps each
-- applied edit, append-only, as the record of who changed what.
--
-- Additive only: no existing column changes, so an old pod keeps working.

ALTER TABLE "ledger"."assets"
  ADD COLUMN "precision" integer,
  ADD COLUMN "networks" jsonb DEFAULT '[]'::jsonb NOT NULL,
  ADD COLUMN "default_network_id" text,
  ADD COLUMN "allowed_actions" text[] DEFAULT '{}'::text[] NOT NULL,
  ADD COLUMN "state" text DEFAULT 'active' NOT NULL,
  ADD COLUMN "revision" integer DEFAULT 0 NOT NULL,
  ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;

UPDATE "ledger"."assets" SET "state" = 'halted' WHERE "active" = false;

ALTER TABLE "ledger"."assets"
  ADD CONSTRAINT "assets_precision_ck" CHECK ("precision" IS NULL OR ("precision" >= 0 AND "precision" <= 18)),
  ADD CONSTRAINT "assets_networks_array_ck" CHECK (jsonb_typeof("networks") = 'array'),
  ADD CONSTRAINT "assets_state_ck" CHECK ("state" IN ('active', 'halted', 'retired')),
  ADD CONSTRAINT "assets_allowed_actions_ck" CHECK ("allowed_actions" <@ ARRAY['deposit', 'withdraw', 'trade', 'transfer']::text[]),
  ADD CONSTRAINT "assets_revision_ck" CHECK ("revision" >= 0);

CREATE TABLE "ledger"."asset_edits" (
  "operation_id" text PRIMARY KEY NOT NULL,
  "approval_id" text NOT NULL,
  "asset_id" text NOT NULL,
  "revision" integer NOT NULL,
  "requester_id" text NOT NULL,
  "approver_id" text NOT NULL,
  "operator_id" text NOT NULL,
  "edit" jsonb NOT NULL,
  "applied_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  CONSTRAINT "asset_edits_asset_id_fk" FOREIGN KEY ("asset_id") REFERENCES "ledger"."assets" ("id") ON DELETE RESTRICT,
  CONSTRAINT "asset_edits_approval_uq" UNIQUE ("approval_id"),
  CONSTRAINT "asset_edits_asset_revision_uq" UNIQUE ("asset_id", "revision"),
  CONSTRAINT "asset_edits_distinct_pair_ck" CHECK ("requester_id" <> "approver_id")
);

CREATE OR REPLACE FUNCTION "ledger"."asset_edits_append_only"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'asset_edits is append-only: % refused', TG_OP
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER "asset_edits_append_only"
  BEFORE UPDATE OR DELETE ON "ledger"."asset_edits"
  FOR EACH ROW EXECUTE FUNCTION "ledger"."asset_edits_append_only"();

CREATE TRIGGER "asset_edits_no_truncate"
  BEFORE TRUNCATE ON "ledger"."asset_edits"
  FOR EACH STATEMENT EXECUTE FUNCTION "ledger"."asset_edits_append_only"();
