-- svc-pay · W16 editable venue, network and wallet-route registries (founder-only).
-- Reversal: 0069_pay_registries.down.sql
--
-- DATA, NOT CONFIG. The conversion workstream (W6) reads these rows to decide
-- where an order may go. They hold no credentials: there is no key, secret,
-- token, password or address column anywhere in this file, by design. A venue's
-- API keys live in the Venue Vault and are never copied here.
--
-- BLANK IS REFUSED. Every limit, confirmation count, fee source and payout cap
-- is nullable and has NO default. A NULL means "not configured", and the reader
-- (src/registries/read-api.ts) returns only rows where everything routing needs
-- is set. No row is seeded: this migration invents no venue, no network, no
-- limit and no fee.
--
-- LIVE IS NOT STORABLE YET. `mode` admits only 'disabled' and 'testnet'. The
-- application type has a 'live' value, and setting it is refused with a typed
-- error. Widening this CHECK is a separate migration that waits for an explicit
-- founder GO. An enabled venue must be in testnet mode.

CREATE TABLE IF NOT EXISTS "pay"."venue_registry" (
  "venue_id"        text PRIMARY KEY,
  "display_name"    text NOT NULL,
  "mode"            text NOT NULL DEFAULT 'disabled',
  "priority"        integer NOT NULL,
  "enabled"         boolean NOT NULL DEFAULT false,
  "min_order"       text,
  "max_order"       text,
  "supported_pairs" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "version"         integer NOT NULL DEFAULT 1,
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  "updated_at"      timestamptz NOT NULL DEFAULT now(),
  "updated_by"      text NOT NULL,
  CONSTRAINT "venue_registry_id_shape" CHECK ("venue_id" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  CONSTRAINT "venue_registry_name_not_blank" CHECK (length(btrim("display_name")) > 0),
  CONSTRAINT "venue_registry_mode_no_live" CHECK ("mode" IN ('disabled', 'testnet')),
  CONSTRAINT "venue_registry_enabled_needs_testnet" CHECK (NOT "enabled" OR "mode" = 'testnet'),
  CONSTRAINT "venue_registry_priority_range" CHECK ("priority" >= 0),
  CONSTRAINT "venue_registry_min_order_decimal" CHECK ("min_order" IS NULL OR "min_order" ~ '^[0-9]+(\.[0-9]{1,18})?$'),
  CONSTRAINT "venue_registry_max_order_decimal" CHECK ("max_order" IS NULL OR "max_order" ~ '^[0-9]+(\.[0-9]{1,18})?$'),
  CONSTRAINT "venue_registry_pairs_array" CHECK (jsonb_typeof("supported_pairs") = 'array'),
  CONSTRAINT "venue_registry_version_positive" CHECK ("version" >= 1),
  CONSTRAINT "venue_registry_updated_by_not_blank" CHECK (length(btrim("updated_by")) > 0)
);

CREATE TABLE IF NOT EXISTS "pay"."network_registry" (
  "network_id"             text PRIMARY KEY,
  "display_name"           text NOT NULL,
  "asset_codes"            jsonb NOT NULL DEFAULT '[]'::jsonb,
  "confirmations_required" integer,
  "enabled"                boolean NOT NULL DEFAULT false,
  "fee_estimate_source"    text,
  "fee_estimate_amount"    text,
  "version"                integer NOT NULL DEFAULT 1,
  "created_at"             timestamptz NOT NULL DEFAULT now(),
  "updated_at"             timestamptz NOT NULL DEFAULT now(),
  "updated_by"             text NOT NULL,
  CONSTRAINT "network_registry_id_shape" CHECK ("network_id" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  CONSTRAINT "network_registry_name_not_blank" CHECK (length(btrim("display_name")) > 0),
  CONSTRAINT "network_registry_assets_array" CHECK (jsonb_typeof("asset_codes") = 'array'),
  CONSTRAINT "network_registry_confirmations_positive" CHECK ("confirmations_required" IS NULL OR "confirmations_required" >= 1),
  CONSTRAINT "network_registry_fee_source_known" CHECK (
    "fee_estimate_source" IS NULL OR "fee_estimate_source" IN ('fixed', 'venue_quote', 'chain_estimate')
  ),
  CONSTRAINT "network_registry_fee_amount_decimal" CHECK (
    "fee_estimate_amount" IS NULL OR "fee_estimate_amount" ~ '^[0-9]+(\.[0-9]{1,18})?$'
  ),
  CONSTRAINT "network_registry_fixed_fee_has_amount" CHECK (
    "fee_estimate_source" IS DISTINCT FROM 'fixed' OR "fee_estimate_amount" IS NOT NULL
  ),
  CONSTRAINT "network_registry_version_positive" CHECK ("version" >= 1),
  CONSTRAINT "network_registry_updated_by_not_blank" CHECK (length(btrim("updated_by")) > 0)
);

CREATE TABLE IF NOT EXISTS "pay"."wallet_routes" (
  "route_id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "asset_code"        text NOT NULL,
  "network_id"        text NOT NULL REFERENCES "pay"."network_registry" ("network_id"),
  "payout_allowed"    boolean NOT NULL DEFAULT false,
  "merchant_allow"    jsonb NOT NULL DEFAULT '[]'::jsonb,
  "merchant_deny"     jsonb NOT NULL DEFAULT '[]'::jsonb,
  "max_single_payout" text,
  "version"           integer NOT NULL DEFAULT 1,
  "created_at"        timestamptz NOT NULL DEFAULT now(),
  "updated_at"        timestamptz NOT NULL DEFAULT now(),
  "updated_by"        text NOT NULL,
  CONSTRAINT "wallet_routes_asset_shape" CHECK ("asset_code" ~ '^[A-Z0-9]{1,16}$'),
  CONSTRAINT "wallet_routes_allow_array" CHECK (jsonb_typeof("merchant_allow") = 'array'),
  CONSTRAINT "wallet_routes_deny_array" CHECK (jsonb_typeof("merchant_deny") = 'array'),
  CONSTRAINT "wallet_routes_max_payout_decimal" CHECK (
    "max_single_payout" IS NULL OR "max_single_payout" ~ '^[0-9]+(\.[0-9]{1,18})?$'
  ),
  CONSTRAINT "wallet_routes_version_positive" CHECK ("version" >= 1),
  CONSTRAINT "wallet_routes_updated_by_not_blank" CHECK (length(btrim("updated_by")) > 0),
  CONSTRAINT "wallet_routes_asset_network_unique" UNIQUE ("asset_code", "network_id")
);
