-- Customer crypto deposit addresses and the owner's deposit settings (W-deposit-01, wallet-deposit-001). NO BALANCE LIVES HERE.
-- `custody_deposit_settings` is the owner's per asset and network entry: the label, the smallest deposit that is credited and how
-- long a customer is told to expect. A pair with no row is not in the catalogue. Nothing has a default, and this migration
-- inserts no row. (A founder form with a second-founder approval is W-deposit-04; until then rows are written by the test profile.)
-- `custody_deposit_addresses` is one durable row per (user, asset, network): the first address issued is the one every later
-- call returns, a restart cannot repeat an address, and no two rows on one network hold the same address (ENGINE D-7).
CREATE TABLE IF NOT EXISTS "pay"."custody_deposit_settings" (
  "asset_id" text NOT NULL,
  "network_id" text NOT NULL,
  "label" text NOT NULL,
  "minimum_deposit" text NOT NULL,
  "estimated_arrival_minutes" integer NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  "set_by" text NOT NULL,
  "set_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("asset_id", "network_id"),
  CONSTRAINT "custody_deposit_settings_ids_ck" CHECK ("asset_id" ~ '^[A-Za-z0-9]{1,16}$' AND "network_id" ~ '^[A-Za-z0-9_-]{1,32}$'),
  CONSTRAINT "custody_deposit_settings_label_ck" CHECK (length(btrim("label")) BETWEEN 1 AND 64),
  CONSTRAINT "custody_deposit_settings_minimum_ck" CHECK ("minimum_deposit" ~ '^(0|[1-9][0-9]{0,29})(\.[0-9]{1,18})?$' AND "minimum_deposit"::numeric > 0),
  CONSTRAINT "custody_deposit_settings_arrival_ck" CHECK ("estimated_arrival_minutes" >= 1),
  CONSTRAINT "custody_deposit_settings_set_by_ck" CHECK (length(btrim("set_by")) > 0)
);

CREATE TABLE IF NOT EXISTS "pay"."custody_deposit_addresses" (
  "user_id" text NOT NULL,
  "asset_id" text NOT NULL,
  "network_id" text NOT NULL,
  "address" text NOT NULL,
  "memo" text,
  "issued_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "asset_id", "network_id"),
  CONSTRAINT "custody_deposit_addresses_address_ck" CHECK (length("address") BETWEEN 1 AND 256 AND "address" !~ '\s'),
  CONSTRAINT "custody_deposit_addresses_memo_ck" CHECK ("memo" IS NULL OR length(btrim("memo")) BETWEEN 1 AND 128)
);
CREATE UNIQUE INDEX IF NOT EXISTS "custody_deposit_addresses_network_address_uq"
  ON "pay"."custody_deposit_addresses" ("network_id", lower("address"));
