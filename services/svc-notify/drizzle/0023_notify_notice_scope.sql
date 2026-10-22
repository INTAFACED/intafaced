-- svc-notify · funding incident scope and phase on public notices (W-compliance-notices-01)
-- Reversal: 0023_notify_notice_scope.down.sql
--
-- asset and network scope an incident or maintenance notice to one asset on one
-- network, so the deposit and withdraw banners show it on that network only.
-- phase is the funding incident status flow. All three are set at draft time
-- and frozen with the rest of the row once published. Existing rows keep null:
-- not scoped, no phase.

ALTER TABLE "notify"."notices"
  ADD COLUMN IF NOT EXISTS "asset"   text,
  ADD COLUMN IF NOT EXISTS "network" text,
  ADD COLUMN IF NOT EXISTS "phase"   text;

ALTER TABLE "notify"."notices" DROP CONSTRAINT IF EXISTS "notices_phase_ck";
ALTER TABLE "notify"."notices" ADD CONSTRAINT "notices_phase_ck"
  CHECK ("phase" IS NULL OR "phase" IN ('investigating', 'identified', 'update', 'monitoring', 'resolved'));

-- Scope is a pair, on incidents and maintenance only; a phase needs a scoped incident and reads resolved only on the closing entry.
ALTER TABLE "notify"."notices" DROP CONSTRAINT IF EXISTS "notices_scope_ck";
ALTER TABLE "notify"."notices" ADD CONSTRAINT "notices_scope_ck" CHECK (
  ("asset" IS NULL) = ("network" IS NULL)
  AND ("asset" IS NULL OR "kind" IN ('incident', 'maintenance'))
  AND ("phase" IS NULL OR ("kind" = 'incident' AND "asset" IS NOT NULL AND ("phase" = 'resolved') = "resolves"))
);

CREATE INDEX IF NOT EXISTS "notices_scope_idx"
  ON "notify"."notices" ("asset", "network")
  WHERE "asset" IS NOT NULL;

CREATE OR REPLACE FUNCTION notify.notice_published_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.status = 'published' THEN
    RAISE EXCEPTION 'notify.notice_published_immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'published' THEN
    IF OLD.id IS DISTINCT FROM NEW.id
      OR OLD.kind IS DISTINCT FROM NEW.kind
      OR OLD.title IS DISTINCT FROM NEW.title
      OR OLD.body IS DISTINCT FROM NEW.body
      OR OLD.published_at IS DISTINCT FROM NEW.published_at
      OR OLD.author_id IS DISTINCT FROM NEW.author_id
      OR OLD.version IS DISTINCT FROM NEW.version
      OR OLD.client_request_id IS DISTINCT FROM NEW.client_request_id
      OR OLD.created_at IS DISTINCT FROM NEW.created_at
      OR OLD.status IS DISTINCT FROM NEW.status
      OR OLD.impact IS DISTINCT FROM NEW.impact
      OR OLD.components IS DISTINCT FROM NEW.components
      OR OLD.parent_id IS DISTINCT FROM NEW.parent_id
      OR OLD.resolves IS DISTINCT FROM NEW.resolves
      OR OLD.changelog IS DISTINCT FROM NEW.changelog
      OR OLD.asset IS DISTINCT FROM NEW.asset
      OR OLD.network IS DISTINCT FROM NEW.network
      OR OLD.phase IS DISTINCT FROM NEW.phase
    THEN
      RAISE EXCEPTION 'notify.notice_published_immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
