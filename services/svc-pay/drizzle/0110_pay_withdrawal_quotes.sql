-- Withdrawal fee quotes (W-withdraw-04, wallet-withdraw-007 and -010). A quote is the customer's preview of one
-- withdrawal: the fee parts, whether the fee is on top of the amount or deducted from it, the net amount and an expiry.
-- It moves nothing and no balance lives here. The fee comes from the network registry; the fee mode and the quote
-- lifetime are owner-set in `withdrawal_quote_policy_events` and read from the latest row, so with no row both are blank
-- and a quote refuses. A stored quote never changes, and one acceptance per quote is a row in
-- `withdrawal_quote_acceptances`, so the terms a customer accepted are the terms the withdrawal keeps.
CREATE TABLE IF NOT EXISTS "pay"."withdrawal_quote_policy_events" (
  "seq" bigserial PRIMARY KEY,
  "fee_mode" text NOT NULL,
  "ttl_seconds" integer NOT NULL,
  "set_by" text NOT NULL,
  "set_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "withdrawal_quote_policy_mode_ck" CHECK ("fee_mode" IN ('on_top', 'deducted')),
  CONSTRAINT "withdrawal_quote_policy_ttl_positive" CHECK ("ttl_seconds" > 0),
  CONSTRAINT "withdrawal_quote_policy_actor_not_blank" CHECK (length(btrim("set_by")) > 0)
);

CREATE TABLE IF NOT EXISTS "pay"."withdrawal_quotes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL,
  "quote_ref" text NOT NULL,
  "asset_id" text NOT NULL,
  "network_id" text NOT NULL REFERENCES "pay"."network_registry" ("network_id"),
  "amount" numeric(38,18) NOT NULL,
  "fee_mode" text NOT NULL,
  "fee_components" jsonb NOT NULL,
  "fee_total" numeric(38,18) NOT NULL,
  "net_amount" numeric(38,18) NOT NULL,
  "total_debit" numeric(38,18) NOT NULL,
  "fee_source" text NOT NULL,
  "registry_version" integer NOT NULL,
  "quoted_at" timestamptz NOT NULL,
  "expires_at" timestamptz NOT NULL,
  CONSTRAINT "withdrawal_quotes_amount_positive" CHECK ("amount" > 0 AND "net_amount" > 0 AND "fee_total" >= 0),
  CONSTRAINT "withdrawal_quotes_mode_ck" CHECK ("fee_mode" IN ('on_top', 'deducted')),
  CONSTRAINT "withdrawal_quotes_components_array" CHECK (jsonb_typeof("fee_components") = 'array'),
  CONSTRAINT "withdrawal_quotes_expiry_after_quote" CHECK ("expires_at" > "quoted_at"),
  CONSTRAINT "withdrawal_quotes_text_ck" CHECK (length(btrim("quote_ref")) > 0 AND length(btrim("asset_id")) > 0
    AND length(btrim("fee_source")) > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS "withdrawal_quotes_user_ref_uq" ON "pay"."withdrawal_quotes" ("user_id", "quote_ref");

CREATE TABLE IF NOT EXISTS "pay"."withdrawal_quote_acceptances" (
  "quote_id" uuid PRIMARY KEY REFERENCES "pay"."withdrawal_quotes" ("id"),
  "user_id" uuid NOT NULL,
  "client_ref" text NOT NULL,
  "accepted_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "withdrawal_quote_acceptances_ref_not_blank" CHECK (length(btrim("client_ref")) > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS "withdrawal_quote_acceptances_user_ref_uq"
  ON "pay"."withdrawal_quote_acceptances" ("user_id", "client_ref");

CREATE OR REPLACE FUNCTION "pay"."withdrawal_quotes_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on pay.% is not permitted: a quote, its acceptance and the quote policy history are never edited or deleted.', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS "withdrawal_quote_policy_events_append_only_trg" ON "pay"."withdrawal_quote_policy_events";
CREATE TRIGGER "withdrawal_quote_policy_events_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pay"."withdrawal_quote_policy_events"
  FOR EACH ROW EXECUTE FUNCTION "pay"."withdrawal_quotes_append_only"();

DROP TRIGGER IF EXISTS "withdrawal_quotes_append_only_trg" ON "pay"."withdrawal_quotes";
CREATE TRIGGER "withdrawal_quotes_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pay"."withdrawal_quotes"
  FOR EACH ROW EXECUTE FUNCTION "pay"."withdrawal_quotes_append_only"();

DROP TRIGGER IF EXISTS "withdrawal_quote_acceptances_append_only_trg" ON "pay"."withdrawal_quote_acceptances";
CREATE TRIGGER "withdrawal_quote_acceptances_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pay"."withdrawal_quote_acceptances"
  FOR EACH ROW EXECUTE FUNCTION "pay"."withdrawal_quotes_append_only"();
