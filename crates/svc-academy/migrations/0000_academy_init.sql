-- svc-academy · initial schema (§8.3 — live lobbies, capacity tiers)
-- Reversal: 0000_academy_init.down.sql
--
-- The "academy" schema itself is created by the database bootstrap
-- (tooling/infra/postgres-init/01-service-schemas.sql), which also grants it to
-- the svc_academy role. Migrations run as that role and hold no database-level
-- CREATE privilege — so a migration physically cannot reach outside its own
-- schema (§2).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- NO MONEY MOVES IN THIS SERVICE.
--
-- `academy` is `custodial: false` in the module registry. The one money-shaped
-- column below is `rooms.min_stake`, and it is a THRESHOLD compared against
-- `token.stakeOf` — svc-token owns the stake, and the answer is never stored
-- here. It is still numeric(38,18) because a threshold compared against a stake
-- has to be the same kind of number as the stake.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Every statement is idempotent: this file is re-runnable, and CHECK
-- constraints are re-asserted with DROP ... IF EXISTS first so tightening one
-- later is an edit here rather than a new migration.

DO $$ BEGIN
  CREATE TYPE "academy"."room_kind" AS ENUM
    ('general', 'futures', 'options', 'meme_war_room', 'forex', 'defi_lab', 'merchant_clinic');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "academy"."room_access" AS ENUM ('free', 'staked', 'invite');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "academy"."session_status" AS ENUM ('scheduled', 'live', 'ended', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "academy"."attendee_role" AS ENUM ('host', 'speaker', 'attendee');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── rooms ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "academy"."rooms" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "slug"       text NOT NULL,
  "name"       text NOT NULL,
  "kind"       "academy"."room_kind" NOT NULL DEFAULT 'general',
  "access"     "academy"."room_access" NOT NULL DEFAULT 'free',
  "min_stake"  numeric(38, 18) NOT NULL DEFAULT 0,
  "capacity"   integer NOT NULL,
  "host_id"    uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "rooms_slug_idx" ON "academy"."rooms" ("slug");
CREATE INDEX        IF NOT EXISTS "rooms_kind_idx" ON "academy"."rooms" ("kind", "access");

ALTER TABLE "academy"."rooms" DROP CONSTRAINT IF EXISTS "rooms_capacity_ck";
ALTER TABLE "academy"."rooms" ADD CONSTRAINT "rooms_capacity_ck" CHECK ("capacity" > 0);

-- A `staked` room with no threshold is a free room that says otherwise, and a
-- threshold on a room that does not gate on stake is a number nothing reads.
-- Both are the sort of quiet inconsistency a UI renders confidently.
ALTER TABLE "academy"."rooms" DROP CONSTRAINT IF EXISTS "rooms_stake_gate_ck";
ALTER TABLE "academy"."rooms" ADD CONSTRAINT "rooms_stake_gate_ck"
  CHECK (("access" = 'staked' AND "min_stake" > 0) OR ("access" <> 'staked' AND "min_stake" = 0));

-- ── room_invites ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "academy"."room_invites" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "room_id"     uuid NOT NULL REFERENCES "academy"."rooms"("id") ON DELETE CASCADE,
  "user_id"     uuid NOT NULL,
  "invited_by"  uuid NOT NULL,
  "expires_at"  timestamptz,
  "used_at"     timestamptz,
  "created_at"  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "room_invites_pk"       ON "academy"."room_invites" ("room_id", "user_id");
CREATE INDEX        IF NOT EXISTS "room_invites_user_idx" ON "academy"."room_invites" ("user_id");

-- ── sessions ─────────────────────────────────────────────────────────────────
-- `scene` is the serializable 2D spatial state (§8.3). jsonb precisely so the
-- VR renderer is a different client over the same rows, not a migration.
CREATE TABLE IF NOT EXISTS "academy"."sessions" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "room_id"         uuid NOT NULL REFERENCES "academy"."rooms"("id") ON DELETE CASCADE,
  "title"           text NOT NULL,
  "host_id"         uuid NOT NULL,
  "status"          "academy"."session_status" NOT NULL DEFAULT 'scheduled',
  "starts_at"       timestamptz NOT NULL,
  "ends_at"         timestamptz,
  "stream_provider" text,
  "stream_room"     text,
  "scene"           jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  "updated_at"      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "sessions_room_idx"   ON "academy"."sessions" ("room_id", "starts_at");
CREATE INDEX IF NOT EXISTS "sessions_status_idx" ON "academy"."sessions" ("status", "starts_at");

ALTER TABLE "academy"."sessions" DROP CONSTRAINT IF EXISTS "sessions_window_ck";
ALTER TABLE "academy"."sessions" ADD CONSTRAINT "sessions_window_ck"
  CHECK ("ends_at" IS NULL OR "ends_at" > "starts_at");

-- ── session_attendees ────────────────────────────────────────────────────────
-- `left_at IS NULL` is presence. Occupancy is a COUNT(*), never a maintained
-- counter — a counter is the one thing in a service certain to drift.
CREATE TABLE IF NOT EXISTS "academy"."session_attendees" (
  "session_id"  uuid NOT NULL REFERENCES "academy"."sessions"("id") ON DELETE CASCADE,
  "user_id"     uuid NOT NULL,
  "role"        "academy"."attendee_role" NOT NULL DEFAULT 'attendee',
  "joined_at"   timestamptz NOT NULL DEFAULT now(),
  "left_at"     timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS "session_attendees_pk"       ON "academy"."session_attendees" ("session_id", "user_id");
CREATE INDEX        IF NOT EXISTS "session_attendees_live_idx" ON "academy"."session_attendees" ("session_id", "left_at");
