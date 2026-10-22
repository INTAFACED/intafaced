-- svc-ledger · one supported asset and network registry on ledger.assets (W-balances-05)
-- Reversal: 0025_asset_registry.down.sql
--
-- Adds the registry fields the contracts row carries (packages/contracts/src/asset-registry.ts): precision, networks,
-- default network, allowed actions, state and revision. Additive only: every new column is nullable or has a
-- fail-closed default, so an old pod keeps working and no existing row changes meaning.
--
-- NOTHING IS DEFAULTED THAT AN OWNER MUST SET:
--   · precision is NULL for every existing row. It is NOT copied from `decimals` (0004 records that column as a
--     declaration nobody reads). A row with NULL precision is not in the registry yet: `assets.get` refuses
--     `ledger.asset_precision_unset` and `assets.list` leaves it out, until a founder edit sets it.
--   · allowed_actions starts empty, so `assetAllows` answers no for every action until an edit lists them.
--   · default_network_id starts NULL (never guessed); networks starts empty.
-- `state` starts 'active' because that is what every existing row already is: the posting path does not read it.
--
-- asset_edits: one row per applied founder edit, keyed by the identity approval id, so an approval applies once.
-- Append-only by trigger, the same way the operator access log is.

ALTER TABLE "ledger"."assets"
  ADD COLUMN "precision" integer NULL CHECK ("precision" BETWEEN 0 AND 18),
  ADD COLUMN "networks" jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof("networks") = 'array'),
  ADD COLUMN "default_network_id" text NULL,
  ADD COLUMN "allowed_actions" text[] NOT NULL DEFAULT '{}'
    CHECK ("allowed_actions" <@ ARRAY['deposit', 'withdraw', 'trade', 'transfer']::text[]),
  ADD COLUMN "state" text NOT NULL DEFAULT 'active' CHECK ("state" IN ('active', 'halted', 'retired')),
  ADD COLUMN "revision" integer NOT NULL DEFAULT 0 CHECK ("revision" >= 0),
  ADD COLUMN "registry_updated_at" timestamptz NOT NULL DEFAULT now();

CREATE TABLE "ledger"."asset_edits" (
  "approval_id" text PRIMARY KEY,
  "operation_id" text NOT NULL,
  "asset_id" text NOT NULL REFERENCES "ledger"."assets" ("id"),
  "revision" integer NOT NULL CHECK ("revision" >= 1),
  "payload_hash" text NOT NULL,
  "edit" jsonb NOT NULL,
  "actor_id" text NOT NULL,
  "approver_id" text NULL,
  "applied_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("asset_id", "revision")
);

CREATE FUNCTION "ledger"."asset_edits_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger.asset_edits is append-only';
END $$;

CREATE TRIGGER "asset_edits_append_only" BEFORE UPDATE OR DELETE ON "ledger"."asset_edits"
  FOR EACH ROW EXECUTE FUNCTION "ledger"."asset_edits_append_only"();
