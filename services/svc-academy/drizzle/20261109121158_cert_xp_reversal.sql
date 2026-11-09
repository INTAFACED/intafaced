-- svc-academy · a revoke takes back the certificate's XP (AC-certificates-02)
-- Reversal: 20261109121158_cert_xp_reversal.down.sql
--
-- A grant records the XP its award was worth when it was issued (`xp_awarded`; null for an unpriced certificate and for
-- grants issued before this column), so a revoke takes back exactly that, never a later policy's amount. A revocation
-- records when its XP was settled (`xp_settled`: the reversal went out, there was nothing to take back, or what was
-- awarded is not recorded), so the issue sweep re-sends the award and its reversal for every revocation still unsettled
-- and the rank always comes back to net zero. XP is an integer and not money; nothing here moves money.

ALTER TABLE "academy"."cert_grants" ADD COLUMN IF NOT EXISTS "xp_awarded" integer;
DO $$ BEGIN
  ALTER TABLE "academy"."cert_grants" ADD CONSTRAINT "cert_grants_xp_awarded_chk" CHECK ("xp_awarded" IS NULL OR "xp_awarded" > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "academy"."cert_revocations" ADD COLUMN IF NOT EXISTS "xp_settled" text;
ALTER TABLE "academy"."cert_revocations" ADD COLUMN IF NOT EXISTS "xp_settled_at" timestamptz;
DO $$ BEGIN
  ALTER TABLE "academy"."cert_revocations"
    ADD CONSTRAINT "cert_revocations_xp_settled_chk" CHECK (
      ("xp_settled" IS NULL AND "xp_settled_at" IS NULL)
      OR ("xp_settled" IN ('reversed', 'no_policy', 'award_unrecorded', 'not_reversible') AND "xp_settled_at" IS NOT NULL)
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "cert_revocations_xp_unsettled_idx"
  ON "academy"."cert_revocations" ("revoked_at") WHERE "xp_settled" IS NULL;
