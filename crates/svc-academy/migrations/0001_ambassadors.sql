-- svc-academy · ambassadors programme Stage-1 (status only — NO PAY)
-- Reversal: 0001_ambassadors.down.sql
--
-- Stage-1 is appoint / freeze / public badge. IFC pay and revenue share are
-- deliberately absent: they MOVE VALUE and need ledger recipes (Class M).
-- A half-built pay path is worse than an absent one.

DO $$ BEGIN
  CREATE TYPE "academy"."ambassador_status" AS ENUM ('active', 'frozen');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "academy"."ambassadors" (
  "user_id"       uuid PRIMARY KEY,
  "status"        "academy"."ambassador_status" NOT NULL DEFAULT 'active',
  "appointed_by"  uuid NOT NULL,
  "appointed_at"  timestamptz NOT NULL DEFAULT now(),
  "frozen_at"     timestamptz,
  "frozen_by"     uuid,
  "freeze_reason" text,
  "updated_at"    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "ambassadors_status_idx"
  ON "academy"."ambassadors" ("status", "appointed_at" DESC);

-- freeze_reason only when frozen; frozen_at/by only when frozen
ALTER TABLE "academy"."ambassadors" DROP CONSTRAINT IF EXISTS "ambassadors_freeze_shape_ck";
ALTER TABLE "academy"."ambassadors" ADD CONSTRAINT "ambassadors_freeze_shape_ck" CHECK (
  ("status" = 'active'  AND "frozen_at" IS NULL AND "frozen_by" IS NULL AND "freeze_reason" IS NULL)
  OR
  ("status" = 'frozen' AND "frozen_at" IS NOT NULL AND "frozen_by" IS NOT NULL
     AND "freeze_reason" IS NOT NULL AND char_length(trim("freeze_reason")) > 0)
);
