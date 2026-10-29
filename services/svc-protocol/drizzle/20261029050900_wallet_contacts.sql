-- svc-protocol · wallet address book and wallet groups (D-portfolio-wallet-03)
-- Reversal: 20261029050900_wallet_contacts.down.sql
--
-- One book per wallet address, read and written only with a wallet session that proves the owner signed (see
-- src/address-book/session.ts). Labels a person keeps for themselves; no balance, no money and no key.

CREATE TABLE IF NOT EXISTS "protocol"."wallet_contacts" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Checksummed EVM address whose book this is.
  "owner_address" text NOT NULL,
  -- Checksummed EVM address of the contact.
  "address"       text NOT NULL,
  "label"         text NOT NULL,
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  "updated_at"    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "wallet_contacts_owner_shape_ck" CHECK ("owner_address" ~ '^0x[0-9a-fA-F]{40}$'),
  CONSTRAINT "wallet_contacts_address_shape_ck" CHECK ("address" ~ '^0x[0-9a-fA-F]{40}$'),
  CONSTRAINT "wallet_contacts_not_self_ck" CHECK ("address" <> "owner_address"),
  CONSTRAINT "wallet_contacts_label_ck" CHECK (char_length("label") BETWEEN 1 AND 64)
);
-- One contact per address in a book.
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_contacts_owner_address_idx" ON "protocol"."wallet_contacts" ("owner_address", "address");

CREATE TABLE IF NOT EXISTS "protocol"."wallet_groups" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "owner_address" text NOT NULL,
  "name"          text NOT NULL,
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  "updated_at"    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "wallet_groups_owner_shape_ck" CHECK ("owner_address" ~ '^0x[0-9a-fA-F]{40}$'),
  CONSTRAINT "wallet_groups_name_ck" CHECK (char_length("name") BETWEEN 1 AND 64)
);
-- One group per name (any case) in a book.
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_groups_owner_name_idx" ON "protocol"."wallet_groups" ("owner_address", lower("name"));

-- A member is the owning wallet itself or the address of one of its contacts; the service checks that on write and
-- takes a removed contact's address out of the owner's groups in the same transaction.
CREATE TABLE IF NOT EXISTS "protocol"."wallet_group_members" (
  "group_id"   uuid NOT NULL REFERENCES "protocol"."wallet_groups" ("id") ON DELETE CASCADE,
  "address"    text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("group_id", "address"),
  CONSTRAINT "wallet_group_members_address_shape_ck" CHECK ("address" ~ '^0x[0-9a-fA-F]{40}$')
);
