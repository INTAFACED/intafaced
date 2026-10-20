-- Purchase holds (W-withdraw-13, wallet-withdraw-047). A card, ACH or PayPal purchase credits the customer's ledger
-- balance as usual; this table records how much of it is held back from WITHDRAWAL (it stays tradable). No balance
-- lives here: the ledger is the balance, and a hold is only a limit on what may leave. Release is a row in
-- `purchase_hold_releases`, so it happens once per hold. The release period is owner-set and read from the latest
-- `purchase_hold_policy_events` row; with no row it is blank and nothing is released or guessed.
CREATE TABLE IF NOT EXISTS "pay"."purchase_holds" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "hold_ref" text NOT NULL,
  "user_id" uuid NOT NULL,
  "asset_id" text NOT NULL,
  "amount" numeric(38,18) NOT NULL,
  "rail" text NOT NULL,
  "purchased_at" timestamptz NOT NULL,
  "recorded_by" text NOT NULL,
  "recorded_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "purchase_holds_amount_positive" CHECK ("amount" > 0),
  CONSTRAINT "purchase_holds_rail_ck" CHECK ("rail" IN ('card', 'ach', 'paypal')),
  CONSTRAINT "purchase_holds_text_ck" CHECK (length(btrim("hold_ref")) > 0 AND length(btrim("asset_id")) > 0
    AND length(btrim("recorded_by")) > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS "purchase_holds_ref_uq" ON "pay"."purchase_holds" ("hold_ref");
CREATE INDEX IF NOT EXISTS "purchase_holds_user_asset_idx" ON "pay"."purchase_holds" ("user_id", "asset_id");

CREATE TABLE IF NOT EXISTS "pay"."purchase_hold_releases" (
  "hold_id" uuid PRIMARY KEY REFERENCES "pay"."purchase_holds" ("id"),
  "released_at" timestamptz NOT NULL DEFAULT now(),
  "released_by" text NOT NULL,
  "basis" text NOT NULL,
  CONSTRAINT "purchase_hold_releases_basis_ck" CHECK ("basis" IN ('period_elapsed', 'operator')),
  CONSTRAINT "purchase_hold_releases_actor_not_blank" CHECK (length(btrim("released_by")) > 0)
);

CREATE TABLE IF NOT EXISTS "pay"."purchase_hold_policy_events" (
  "seq" bigserial PRIMARY KEY,
  "hold_seconds" integer NOT NULL,
  "set_by" text NOT NULL,
  "set_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "purchase_hold_policy_seconds_positive" CHECK ("hold_seconds" > 0),
  CONSTRAINT "purchase_hold_policy_actor_not_blank" CHECK (length(btrim("set_by")) > 0)
);

CREATE OR REPLACE FUNCTION "pay"."purchase_holds_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on pay.% is not permitted: a purchase hold, its release and the period history are never edited or deleted.', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS "purchase_holds_append_only_trg" ON "pay"."purchase_holds";
CREATE TRIGGER "purchase_holds_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pay"."purchase_holds"
  FOR EACH ROW EXECUTE FUNCTION "pay"."purchase_holds_append_only"();

DROP TRIGGER IF EXISTS "purchase_hold_releases_append_only_trg" ON "pay"."purchase_hold_releases";
CREATE TRIGGER "purchase_hold_releases_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pay"."purchase_hold_releases"
  FOR EACH ROW EXECUTE FUNCTION "pay"."purchase_holds_append_only"();

DROP TRIGGER IF EXISTS "purchase_hold_policy_events_append_only_trg" ON "pay"."purchase_hold_policy_events";
CREATE TRIGGER "purchase_hold_policy_events_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pay"."purchase_hold_policy_events"
  FOR EACH ROW EXECUTE FUNCTION "pay"."purchase_holds_append_only"();
