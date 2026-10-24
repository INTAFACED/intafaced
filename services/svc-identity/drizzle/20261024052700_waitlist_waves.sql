-- Referral-ranked waitlist waves (RC-campaigns-03; J-campaigns-20 #3). An operator, with a second person's approval,
-- releases the next wave: the top N entries still waiting, ranked by referred_count descending, then join order. N is
-- the owner's wave size, recorded on the wave row. One waitlist_releases row per released entry, keyed by the entry, so
-- an entry is released once; release_key is the business key wave:<wave number>:<entry id>. A release is a record, not
-- a sign-up: no account is created and nothing moves value. The wave row and its release rows are written in one
-- transaction, so a crash leaves either the whole wave or none of it.
-- Reversal: 20261024052700_waitlist_waves.down.sql

CREATE TABLE IF NOT EXISTS "identity"."waitlist_waves" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "wave_number"    integer NOT NULL,
  "size"           integer NOT NULL,
  "released_count" integer NOT NULL,
  "flag_key"       text NOT NULL,
  "released_by"    uuid NOT NULL,
  "approved_by"    uuid NOT NULL,
  "released_at"    timestamptz NOT NULL DEFAULT now(),
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "waitlist_waves_number_ck" CHECK ("wave_number" > 0),
  CONSTRAINT "waitlist_waves_size_ck" CHECK ("size" > 0),
  CONSTRAINT "waitlist_waves_count_ck" CHECK ("released_count" > 0 AND "released_count" <= "size")
);

CREATE UNIQUE INDEX IF NOT EXISTS "waitlist_waves_number_idx"
  ON "identity"."waitlist_waves" ("wave_number");

CREATE TABLE IF NOT EXISTS "identity"."waitlist_releases" (
  "entry_id"    uuid PRIMARY KEY REFERENCES "identity"."waitlist_entries"("id") ON DELETE CASCADE,
  "wave_id"     uuid NOT NULL REFERENCES "identity"."waitlist_waves"("id") ON DELETE CASCADE,
  "release_key" text NOT NULL,
  "released_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "waitlist_releases_key_idx"
  ON "identity"."waitlist_releases" ("release_key");
CREATE INDEX IF NOT EXISTS "waitlist_releases_wave_idx"
  ON "identity"."waitlist_releases" ("wave_id");

-- The queue order a release picks by and the rank read counts by.
CREATE INDEX IF NOT EXISTS "waitlist_entries_rank_idx"
  ON "identity"."waitlist_entries" ("referred_count" DESC, "position");
