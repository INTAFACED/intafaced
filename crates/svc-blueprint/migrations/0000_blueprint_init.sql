-- svc-blueprint · initial schema (§7.1 SOVEREIGN BLUEPRINT)
-- Reversal: 0000_blueprint_init.down.sql
--
-- The "blueprint" schema itself is created by the database bootstrap
-- (tooling/infra/postgres-init/01-service-schemas.sql), which also grants it to
-- the svc_blueprint role. Migrations run as that role and hold no
-- database-level CREATE privilege — so a migration physically cannot reach
-- outside its own schema (§2).
--
-- §10 PII isolation, stated once so it is not re-litigated per table: this
-- schema stores the DERIVED profile and nothing a user typed. There is no
-- birth-data column, no transcript column, no free-text answer column. The
-- session's inputs cross the wire to the engine and are dropped. That absence
-- is the control.
--
-- Every statement below is idempotent: this file is re-runnable, and CHECK
-- constraints are dropped before being re-asserted so tightening one later is
-- an edit here rather than a new migration.

DO $$ BEGIN
  CREATE TYPE "blueprint"."blueprint_visibility" AS ENUM ('private', 'crew', 'public');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "blueprint"."crew_role" AS ENUM ('anchor', 'scout', 'builder', 'catalyst');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "blueprint"."mentor_match_status" AS ENUM ('shortlisted', 'accepted', 'declined', 'ended');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── blueprints ───────────────────────────────────────────────────────────────
-- One Identity Blueprint per account (§7.1).

CREATE TABLE IF NOT EXISTS "blueprint"."blueprints" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"         uuid NOT NULL,
  "engine_version"  text NOT NULL,
  -- The five axes plus curriculum path, tone register and default agent
  -- guardrails. Never logged, never traced, never carried on an event.
  "profile"         jsonb NOT NULL,
  -- Populated by the `blueprint.card` feature (separate). Null until then.
  "card_asset_url"  text,
  "visibility"      "blueprint"."blueprint_visibility" NOT NULL DEFAULT 'private',
  "mentor_available" boolean NOT NULL DEFAULT false,
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  "updated_at"      timestamptz NOT NULL DEFAULT now()
);

-- A second Blueprint for one account makes "which one is you" ambiguous, and
-- every downstream reader (svc-trade guardrails, svc-agents tone) would resolve
-- it by whichever row it happened to read first.
CREATE UNIQUE INDEX IF NOT EXISTS "blueprints_user_idx" ON "blueprint"."blueprints" ("user_id");
CREATE INDEX IF NOT EXISTS "blueprints_mentor_idx" ON "blueprint"."blueprints" ("mentor_available");

-- The profile is an object with the five §7.1 axes. A profile that arrived as
-- an array, a string or a bare null would satisfy `jsonb NOT NULL` and then
-- fail much later, inside a matching run, as an unreadable score.
ALTER TABLE "blueprint"."blueprints" DROP CONSTRAINT IF EXISTS "blueprints_profile_shape_ck";
ALTER TABLE "blueprint"."blueprints" ADD CONSTRAINT "blueprints_profile_shape_ck"
  CHECK (
    jsonb_typeof("profile") = 'object'
    AND "profile" ? 'decisionStyle'
    AND "profile" ? 'riskTemperament'
    AND "profile" ? 'energyRhythm'
    AND "profile" ? 'learningMode'
    AND "profile" ? 'crewRole'
  );

-- THE PII BACKSTOP (§10). The service never writes these keys; this constraint
-- makes it impossible for a future caller — or a hand-run UPDATE — to smuggle
-- raw session input into the profile blob where it would then be exported,
-- cached downstream, and copied into every backup we hold.
ALTER TABLE "blueprint"."blueprints" DROP CONSTRAINT IF EXISTS "blueprints_profile_no_pii_ck";
ALTER TABLE "blueprint"."blueprints" ADD CONSTRAINT "blueprints_profile_no_pii_ck"
  CHECK (
    NOT ("profile" ?| ARRAY['birthData', 'birth_data', 'birthDate', 'birthTime', 'birthPlace', 'responses', 'transcript', 'rawInput'])
  );

-- ── crews ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "blueprint"."crews" (
  "id"        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name"      text NOT NULL,
  "formed_at" timestamptz NOT NULL DEFAULT now(),
  "season"    integer NOT NULL DEFAULT 1,
  -- A count of shared achievement, not money. This is deliberately a bigint and
  -- not numeric(38,18): it must never be mistaken for a ledger balance (§0.6).
  "xp"        bigint NOT NULL DEFAULT 0,
  "lobby_id"  uuid,
  -- Capacity is data, not a constant, so a season can run larger or smaller
  -- crews without a migration.
  "capacity"  integer NOT NULL DEFAULT 6
);

-- Two crews with the same name in one season are indistinguishable in a lobby
-- list, and the deterministic namer would have to break ties by id — which is
-- exactly the non-reproducible behaviour matching is built to avoid.
CREATE UNIQUE INDEX IF NOT EXISTS "crews_name_season_idx" ON "blueprint"."crews" ("name", "season");
CREATE INDEX IF NOT EXISTS "crews_season_idx" ON "blueprint"."crews" ("season");

-- A crew with capacity 0 can never accept the member it was just formed for,
-- so onboarding would form a fresh crew on every attempt, forever.
ALTER TABLE "blueprint"."crews" DROP CONSTRAINT IF EXISTS "crews_capacity_positive_ck";
ALTER TABLE "blueprint"."crews" ADD CONSTRAINT "crews_capacity_positive_ck"
  CHECK ("capacity" > 0);

-- Negative XP would invert every crew ladder it is sorted by.
ALTER TABLE "blueprint"."crews" DROP CONSTRAINT IF EXISTS "crews_xp_non_negative_ck";
ALTER TABLE "blueprint"."crews" ADD CONSTRAINT "crews_xp_non_negative_ck"
  CHECK ("xp" >= 0);

ALTER TABLE "blueprint"."crews" DROP CONSTRAINT IF EXISTS "crews_season_positive_ck";
ALTER TABLE "blueprint"."crews" ADD CONSTRAINT "crews_season_positive_ck"
  CHECK ("season" >= 1);

-- ── crew_members ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "blueprint"."crew_members" (
  "crew_id"   uuid NOT NULL REFERENCES "blueprint"."crews"("id") ON DELETE CASCADE,
  "user_id"   uuid NOT NULL,
  "role"      "blueprint"."crew_role" NOT NULL,
  "joined_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("crew_id", "user_id")
);

-- ONE CREW PER USER. This is what makes re-running matching idempotent at the
-- database level rather than only in the service: a retried placement cannot
-- create a second membership, so "which crew am I in" always has one answer.
CREATE UNIQUE INDEX IF NOT EXISTS "crew_members_user_idx" ON "blueprint"."crew_members" ("user_id");
CREATE INDEX IF NOT EXISTS "crew_members_crew_idx" ON "blueprint"."crew_members" ("crew_id");

-- ── match_runs ───────────────────────────────────────────────────────────────
-- The audit trail of a placement: what was considered, what it scored, where
-- the user landed (§7.1).

CREATE TABLE IF NOT EXISTS "blueprint"."match_runs" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"        uuid NOT NULL,
  -- `[{ "crewId": ..., "size": n }]`. Crew ids and sizes ONLY. Storing the
  -- candidates' profiles here would copy other people's derived PII into this
  -- user's export, where an erasure request for them could never reach it.
  "candidates"     jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- `{ "<crewId>": <basis points> }`. Integers — a reproducible score cannot
  -- be a float.
  "scores"         jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- SET NULL, not CASCADE: when a crew is dissolved the run still happened, and
  -- deleting the history would rewrite an audit trail to tidy up a foreign key.
  "placed_crew_id" uuid REFERENCES "blueprint"."crews"("id") ON DELETE SET NULL,
  "ts"             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "match_runs_user_idx" ON "blueprint"."match_runs" ("user_id", "ts");

ALTER TABLE "blueprint"."match_runs" DROP CONSTRAINT IF EXISTS "match_runs_candidates_shape_ck";
ALTER TABLE "blueprint"."match_runs" ADD CONSTRAINT "match_runs_candidates_shape_ck"
  CHECK (jsonb_typeof("candidates") = 'array' AND jsonb_typeof("scores") = 'object');

-- ── mentor_matches ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "blueprint"."mentor_matches" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "student_id" uuid NOT NULL,
  "mentor_id"  uuid NOT NULL,
  "fit_score"  integer NOT NULL,
  "status"     "blueprint"."mentor_match_status" NOT NULL DEFAULT 'shortlisted',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

-- One shortlist entry per pair. A re-run of the shortlist must refresh a score,
-- never stack a second row that then appears twice in the student's list.
CREATE UNIQUE INDEX IF NOT EXISTS "mentor_matches_pair_idx"
  ON "blueprint"."mentor_matches" ("student_id", "mentor_id");
CREATE INDEX IF NOT EXISTS "mentor_matches_student_idx"
  ON "blueprint"."mentor_matches" ("student_id", "status");
-- Erasing a MENTOR has to find their rows as cheaply as erasing a student's.
-- Without this index the §7.2 cascade degrades to a sequential scan exactly
-- when it is under a deletion deadline.
CREATE INDEX IF NOT EXISTS "mentor_matches_mentor_idx" ON "blueprint"."mentor_matches" ("mentor_id");

-- Nobody mentors themselves; a self-match would occupy a shortlist slot and
-- score maximally on every affinity axis by construction.
ALTER TABLE "blueprint"."mentor_matches" DROP CONSTRAINT IF EXISTS "mentor_matches_not_self_ck";
ALTER TABLE "blueprint"."mentor_matches" ADD CONSTRAINT "mentor_matches_not_self_ck"
  CHECK ("student_id" <> "mentor_id");

-- Scores are basis points. Out-of-range values would sort a shortlist into an
-- order the scoring function never produced.
ALTER TABLE "blueprint"."mentor_matches" DROP CONSTRAINT IF EXISTS "mentor_matches_fit_range_ck";
ALTER TABLE "blueprint"."mentor_matches" ADD CONSTRAINT "mentor_matches_fit_range_ck"
  CHECK ("fit_score" >= 0 AND "fit_score" <= 10000);
