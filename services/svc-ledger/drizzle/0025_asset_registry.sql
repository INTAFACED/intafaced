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
-- No new table (the one-book scan allows only the ledger's own tables). The last applied edit is named on the row
-- itself: the identity approval id (unique, so one approval names at most one row), its operation id, who applied it
-- and who approved it. The approval history itself is identity's.

ALTER TABLE "ledger"."assets"
  ADD COLUMN "precision" integer NULL CHECK ("precision" BETWEEN 0 AND 18),
  ADD COLUMN "networks" jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof("networks") = 'array'),
  ADD COLUMN "default_network_id" text NULL,
  ADD COLUMN "allowed_actions" text[] NOT NULL DEFAULT '{}'
    CHECK ("allowed_actions" <@ ARRAY['deposit', 'withdraw', 'trade', 'transfer']::text[]),
  ADD COLUMN "state" text NOT NULL DEFAULT 'active' CHECK ("state" IN ('active', 'halted', 'retired')),
  ADD COLUMN "revision" integer NOT NULL DEFAULT 0 CHECK ("revision" >= 0),
  ADD COLUMN "registry_updated_at" timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN "last_approval_id" text NULL UNIQUE,
  ADD COLUMN "last_operation_id" text NULL,
  ADD COLUMN "last_edited_by" text NULL,
  ADD COLUMN "last_approved_by" text NULL,
  ADD CONSTRAINT "assets_registry_edit_named" CHECK (("revision" = 0) = ("last_approval_id" IS NULL));
