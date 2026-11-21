-- svc-academy · tournament ladders Stage-1 (NO PRIZE MONEY)
-- Reversal: 0002_tournaments.down.sql
--
-- Stage-1: seasons + standings. Prize escrow/payout is Class M Stage-2 and
-- must not land as columns that look like balances.

DO $$ BEGIN
  CREATE TYPE "academy"."season_status" AS ENUM ('scheduled', 'live', 'frozen', 'ended');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "academy"."tournament_seasons" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "slug"           text NOT NULL,
  "title"          text NOT NULL,
  "status"         "academy"."season_status" NOT NULL DEFAULT 'scheduled',
  "rules_summary"  text NOT NULL,
  "starts_at"      timestamptz NOT NULL,
  "ends_at"        timestamptz,
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  "updated_at"     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "tournament_seasons_slug_idx"
  ON "academy"."tournament_seasons" ("slug");
CREATE INDEX IF NOT EXISTS "tournament_seasons_status_idx"
  ON "academy"."tournament_seasons" ("status", "starts_at" DESC);

CREATE TABLE IF NOT EXISTS "academy"."tournament_standings" (
  "season_id"   uuid NOT NULL REFERENCES "academy"."tournament_seasons"("id") ON DELETE CASCADE,
  "user_id"     uuid NOT NULL,
  "score"       integer NOT NULL DEFAULT 0,
  "updated_at"  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("season_id", "user_id")
);

ALTER TABLE "academy"."tournament_standings" DROP CONSTRAINT IF EXISTS "tournament_standings_score_ck";
ALTER TABLE "academy"."tournament_standings" ADD CONSTRAINT "tournament_standings_score_ck"
  CHECK ("score" >= 0 AND "score" <= 1000000000);

CREATE INDEX IF NOT EXISTS "tournament_standings_rank_idx"
  ON "academy"."tournament_standings" ("season_id", "score" DESC, "updated_at" ASC);
