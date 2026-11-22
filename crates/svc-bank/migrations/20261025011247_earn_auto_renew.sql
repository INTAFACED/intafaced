-- Fixed-term auto-renew (BK-earn-03, crypto-credit-earn-057, J-bank-08 #4): a saver asks for a fixed-term saving to
-- start a new term of the same length, with the same amount, when the one it is in ends.
--
-- `auto_renew` is the saver's choice, off unless they turn it on, and only a fixed-term saving (one with a maturity)
-- can carry it. Each renewal is one row in `earn_renewals`, keyed by (position, term): the relock's business key
-- `earn-relock:<positionId>:<term>`, so a job that runs twice renews once. A renewal moves no money: the principal
-- never left the saving's stake pot, so the row moves the saving's maturity and nothing else. A row is never edited
-- or deleted; it is how the saver and an operator see when each term began and ended.
--
-- Reversal: 20261025011247_earn_auto_renew.down.sql (refuses while any renewal is recorded).

ALTER TABLE "bank"."earn_positions" ADD COLUMN IF NOT EXISTS "auto_renew" boolean NOT NULL DEFAULT false;
ALTER TABLE "bank"."earn_positions" DROP CONSTRAINT IF EXISTS "earn_positions_auto_renew_fixed_ck";
ALTER TABLE "bank"."earn_positions" ADD CONSTRAINT "earn_positions_auto_renew_fixed_ck"
  CHECK (NOT "auto_renew" OR "matures_at" IS NOT NULL);

CREATE TABLE IF NOT EXISTS "bank"."earn_renewals" (
  "position_id" uuid NOT NULL REFERENCES "bank"."earn_positions" ("id"),
  "term" integer NOT NULL,
  "previous_matures_at" timestamptz NOT NULL,
  "matures_at" timestamptz NOT NULL,
  "principal" numeric(38, 18) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("position_id", "term"),
  CONSTRAINT "earn_renewals_term_ck" CHECK ("term" > 0),
  CONSTRAINT "earn_renewals_later_ck" CHECK ("matures_at" > "previous_matures_at"),
  CONSTRAINT "earn_renewals_principal_ck" CHECK ("principal" > 0)
);

CREATE OR REPLACE FUNCTION "bank"."earn_renewals_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'earn_renewals row (%, %) is append-only: a renewal that happened stays recorded', OLD."position_id", OLD."term"
    USING ERRCODE = '23514';
END;
$$;

CREATE OR REPLACE TRIGGER "earn_renewals_append_only_trg"
  BEFORE UPDATE OR DELETE ON "bank"."earn_renewals"
  FOR EACH ROW EXECUTE FUNCTION "bank"."earn_renewals_append_only"();
