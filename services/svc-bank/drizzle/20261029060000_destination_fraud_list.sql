-- The owner's destination fraud list (W-withdraw-03, J-wallet-05 #2): withdrawal addresses the compliance desk has listed as
-- fraud, on one network or on every network ('*'). An address on it is never saved to a customer's address book, and a saved
-- entry that is listed later reads as blocked before a send. An EVM address is kept in lower case, so a listing matches the
-- address however it is written; any other address is kept exactly as written.
--
-- A list is content, not a magnitude: no row lists nothing, and an empty list refuses nothing. This migration lists no
-- address. Every change (listing or delisting one address) needs a second person and bumps the entry's revision by one; the
-- history row for (network, address, revision) carries the business key `ops-fraud-list:<network>:<address>:<revision>`, so
-- a retried change replays and two people racing on one revision produce one change and one `bank.ops_revision_conflict`.
-- The history is append-only: a trigger refuses every UPDATE and DELETE on it.
--
-- Reversal: 20261029060000_destination_fraud_list.down.sql

CREATE TABLE IF NOT EXISTS "bank"."destination_fraud_list" (
  "network" text NOT NULL,
  "address_key" text NOT NULL,
  "listed" boolean NOT NULL,
  "revision" integer NOT NULL,
  "reason" text NOT NULL,
  "approved_by" text NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("network", "address_key"),
  CONSTRAINT "destination_fraud_list_network_ck" CHECK ("network" = '*' OR "network" ~ '^[a-z0-9_-]{1,32}$'),
  CONSTRAINT "destination_fraud_list_address_ck" CHECK (length("address_key") BETWEEN 1 AND 256 AND "address_key" !~ '\s'),
  CONSTRAINT "destination_fraud_list_revision_ck" CHECK ("revision" >= 1),
  CONSTRAINT "destination_fraud_list_reason_ck" CHECK (length(btrim("reason")) >= 10),
  CONSTRAINT "destination_fraud_list_approved_by_ck" CHECK (length(btrim("approved_by")) > 0)
);
CREATE INDEX IF NOT EXISTS "destination_fraud_list_listed_idx" ON "bank"."destination_fraud_list" ("address_key") WHERE "listed";

CREATE TABLE IF NOT EXISTS "bank"."destination_fraud_list_history" (
  "network" text NOT NULL,
  "address_key" text NOT NULL,
  "revision" integer NOT NULL,
  "change_key" text NOT NULL,
  "listed" boolean NOT NULL,
  "reason" text NOT NULL,
  "requested_by" text NOT NULL,
  "approved_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("network", "address_key", "revision"),
  CONSTRAINT "destination_fraud_list_history_change_key_uq" UNIQUE ("change_key"),
  CONSTRAINT "destination_fraud_list_history_revision_ck" CHECK ("revision" >= 1),
  CONSTRAINT "destination_fraud_list_history_people_ck" CHECK (length(btrim("requested_by")) > 0 AND length(btrim("approved_by")) > 0)
);

CREATE OR REPLACE FUNCTION "bank"."destination_fraud_list_history_append_only"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'bank.destination_fraud_list_history is append-only';
END;
$$;
DROP TRIGGER IF EXISTS "destination_fraud_list_history_append_only_trg" ON "bank"."destination_fraud_list_history";
CREATE TRIGGER "destination_fraud_list_history_append_only_trg"
  BEFORE UPDATE OR DELETE ON "bank"."destination_fraud_list_history"
  FOR EACH ROW EXECUTE FUNCTION "bank"."destination_fraud_list_history_append_only"();
