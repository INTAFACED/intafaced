-- trade · VIP application review and trial (SP-fees-vip-04 part 2, J-cex-spot-10 #7)
-- Reversal: 20261025030000_vip_reviews.down.sql
--
-- Compliance decides a pending application with a second operator's approval (identity's action approval, consumed
-- once). An approval grants the trial the owner publishes (`tierProgram.trial`); with none published the application
-- is `approved_no_trial` and the grant refuses `vip.trial_unset` until one is. A trial is a time-limited fee tier,
-- keyed `vip-trial:<userId>:<applicationId>`, one per application, its span whole 24-hour days (not calendar days in
-- the session's time zone). It moves no money.

-- Who decided, with whose approval: the second operator and the approval consumed are on the decision's event.
ALTER TABLE "trade"."vip_application_events" ADD COLUMN IF NOT EXISTS "approver_id" text;
ALTER TABLE "trade"."vip_application_events" ADD COLUMN IF NOT EXISTS "approval_id" text;
ALTER TABLE "trade"."vip_application_events" DROP CONSTRAINT IF EXISTS "vip_application_events_four_eyes_ck";
ALTER TABLE "trade"."vip_application_events" ADD CONSTRAINT "vip_application_events_four_eyes_ck" CHECK (
  ("approver_id" IS NULL AND "approval_id" IS NULL)
  OR ("approver_id" IS NOT NULL AND "approval_id" IS NOT NULL AND lower(btrim("approver_id")) <> lower(btrim("actor_id")))
);
CREATE UNIQUE INDEX IF NOT EXISTS "vip_application_events_approval_idx"
  ON "trade"."vip_application_events" ("approval_id") WHERE "approval_id" IS NOT NULL;

-- A status moves forward only: pending to a decision, and approved_no_trial to approved once a trial is granted.
CREATE OR REPLACE FUNCTION "trade"."vip_applications_status_forward"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
       (OLD."status" = 'pending' AND NEW."status" IN ('approved', 'approved_no_trial', 'rejected'))
    OR (OLD."status" = 'approved_no_trial' AND NEW."status" = 'approved')
  ) THEN
    RAISE EXCEPTION 'trade.vip_applications: % cannot become %.', OLD."status", NEW."status" USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "vip_applications_status_forward_trg" ON "trade"."vip_applications";
CREATE TRIGGER "vip_applications_status_forward_trg"
  BEFORE UPDATE ON "trade"."vip_applications"
  FOR EACH ROW EXECUTE FUNCTION "trade"."vip_applications_status_forward"();

CREATE TABLE IF NOT EXISTS "trade"."vip_trials" (
  "id"                uuid PRIMARY KEY,
  "trial_key"         text NOT NULL,
  "user_id"           uuid NOT NULL,
  "application_id"    uuid NOT NULL REFERENCES "trade"."vip_applications"("id"),
  "tier_id"           text NOT NULL CONSTRAINT "vip_trials_tier_ck" CHECK (length(btrim("tier_id")) > 0 AND "tier_id" <> 'regular'),
  "days"              integer NOT NULL CONSTRAINT "vip_trials_days_ck" CHECK ("days" BETWEEN 1 AND 366),
  "starts_at"         timestamptz NOT NULL,
  "ends_at"           timestamptz NOT NULL,
  "schedule_version"  text NOT NULL,
  "granted_by"        text NOT NULL CONSTRAINT "vip_trials_granted_by_ck" CHECK (length(btrim("granted_by")) > 0),
  "created_at"        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "vip_trials_key_ck" CHECK ("trial_key" = 'vip-trial:' || "user_id"::text || ':' || "application_id"::text),
  CONSTRAINT "vip_trials_span_ck" CHECK ("ends_at" = "starts_at" + make_interval(hours => "days" * 24))
);
CREATE UNIQUE INDEX IF NOT EXISTS "vip_trials_key_idx" ON "trade"."vip_trials" ("trial_key");
CREATE UNIQUE INDEX IF NOT EXISTS "vip_trials_application_idx" ON "trade"."vip_trials" ("application_id");
CREATE INDEX IF NOT EXISTS "vip_trials_user_idx" ON "trade"."vip_trials" ("user_id", "ends_at" DESC);

CREATE OR REPLACE FUNCTION "trade"."vip_trials_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'trade.vip_trials is append-only: % is not permitted.', TG_OP USING ERRCODE = 'restrict_violation';
END;
$$;
DROP TRIGGER IF EXISTS "vip_trials_append_only_trg" ON "trade"."vip_trials";
CREATE TRIGGER "vip_trials_append_only_trg"
  BEFORE UPDATE OR DELETE ON "trade"."vip_trials"
  FOR EACH ROW EXECUTE FUNCTION "trade"."vip_trials_append_only"();
