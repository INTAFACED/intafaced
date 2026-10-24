-- A referral relationship ends after the owner's inactivity period (CM-referral-01, ENGINE RF-4; J-campaigns-05 #7).
-- referral_activity holds when each person's latest fee event reached identity (the producer accrue door), stamped
-- with the database's own clock, whether or not the fee earned any commission. The sweep removes a referral edge whose
-- person has had no fee event for the period and writes one referral_lapses row in the same statement; the row is the
-- lapse event and its audit record, keyed by the edge (person, referrer, attributed at), so a second sweep of the same
-- edge writes nothing. Stored accruals are not touched. A person whose relationship lapsed may attach again by link.
-- Lapse rows carry no foreign key, so the audit log outlives the account.
-- Reversal: 0076_referral_lapses.down.sql

CREATE TABLE IF NOT EXISTS "identity"."referral_activity" (
  "user_id" uuid PRIMARY KEY REFERENCES "identity"."users"("id") ON DELETE CASCADE,
  "last_fee_at" timestamptz NOT NULL
);

-- Fee events already stored as accruals count as activity, never later than now.
INSERT INTO "identity"."referral_activity" ("user_id", "last_fee_at")
SELECT a."payer_id", LEAST(max(a."accrued_at"), now())
FROM "identity"."affiliate_commission_accruals" a
JOIN "identity"."users" u ON u."id" = a."payer_id"
GROUP BY a."payer_id"
ON CONFLICT ("user_id") DO NOTHING;

CREATE TABLE IF NOT EXISTS "identity"."referral_lapses" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL,
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
