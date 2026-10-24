-- A referral relationship ends after the owner's inactivity period (CM-referral-01, ENGINE RF-4; J-campaigns-05 #7).
-- The sweep removes the referral edge and writes one row here in the same transaction; the row is the lapse event and
-- its audit record. It is keyed by the edge (person, referrer, attributed at), so a second sweep of the same edge writes
-- nothing. Stored accruals are not touched. A person whose relationship lapsed may attach again through a link.
-- Reversal: 0076_referral_lapses.down.sql

CREATE TABLE IF NOT EXISTS "identity"."referral_lapses" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "identity"."users"("id") ON DELETE CASCADE,
  "referrer_id" uuid NOT NULL,
  "attributed_at" timestamptz NOT NULL,
  "last_activity_at" timestamptz NOT NULL,
  "period_seconds" integer NOT NULL CHECK ("period_seconds" > 0),
  "lapsed_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "referral_lapses_edge_uq" UNIQUE ("user_id", "referrer_id", "attributed_at")
);

CREATE INDEX IF NOT EXISTS "referral_lapses_user_idx"
  ON "identity"."referral_lapses" ("user_id", "lapsed_at" DESC);
CREATE INDEX IF NOT EXISTS "referral_lapses_lapsed_idx"
  ON "identity"."referral_lapses" ("lapsed_at" DESC);

-- The sweep reads each referred person's latest commission-bearing fee event.
CREATE INDEX IF NOT EXISTS "affiliate_commission_accruals_payer_idx"
  ON "identity"."affiliate_commission_accruals" ("payer_id", "accrued_at" DESC);
