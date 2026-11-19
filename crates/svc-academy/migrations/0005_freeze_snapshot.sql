-- svc-academy · tournament freeze standings snapshot (NO PRIZE MONEY)
-- Reversal: 0005_freeze_snapshot.down.sql
--
-- On live→frozen the ranked standings at freeze time are durable for audit.
-- Rank + score + user only — no prize / IFC / amount columns.

CREATE TABLE IF NOT EXISTS "academy"."tournament_freeze_snapshots" (
  "season_id"   uuid PRIMARY KEY REFERENCES "academy"."tournament_seasons"("id") ON DELETE CASCADE,
  "frozen_at"   timestamptz NOT NULL,
  "standings"   jsonb NOT NULL,
  "created_at"  timestamptz NOT NULL DEFAULT now()
);

-- Refuse prize-shaped keys at the JSON layer is enforced in app code
-- (assertNoPrizeAttachment). DB stores audit rank table only.
