-- J-derivatives-07 #5: a person's acknowledgement of a venue's auto-deleveraging rules, one row per person and venue,
-- holding the version of the venue's words they read. A version the venue has since replaced does not count as read.
-- No money: the venue runs its auto-deleveraging, and our ledger posts nothing for it.
-- Reversal: 20261118030000_venue_adl_acks.down.sql

CREATE TABLE IF NOT EXISTS "trade"."venue_adl_acks" (
  "user_id"          uuid NOT NULL,
  "venue_id"         text NOT NULL,
  "version"          text NOT NULL,
  "acknowledged_at"  timestamptz NOT NULL,
  "created_at"       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "venue_id"),
  CONSTRAINT "venue_adl_acks_version_ck" CHECK (length("version") BETWEEN 1 AND 200)
);
