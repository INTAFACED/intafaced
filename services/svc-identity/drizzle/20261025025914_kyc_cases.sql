-- svc-identity · KYC cases (I-kyc-compliance-01, J-identity-08 #6). A case is one verification request and what was
-- decided on it: it opens with the pending kyc_records row it belongs to, and moves to approved or rejected with that
-- row, in the same transaction. A reject names a code from the owner's reason list; a note to the customer shows only
-- when the reviewer marks it visible. A resubmission after a reject opens a new case linked to the rejected one.
-- Every transition appends one history row (case, version); the relay publishes kycSubmitted and kycRejected from
-- those rows after commit, at least once, keyed identity.kyc.<verb>:<caseId>:<version>, and marks the row after.
-- Cases for records that exist before this migration are backfilled with their history already marked published, so
-- nothing old is announced. Reversal: the .down.sql of the same name.
CREATE TABLE IF NOT EXISTS "identity"."kyc_cases" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"          uuid NOT NULL REFERENCES "identity"."users" ("id") ON DELETE CASCADE,
  "record_id"        uuid NOT NULL REFERENCES "identity"."kyc_records" ("id") ON DELETE CASCADE,
  "previous_case_id" uuid REFERENCES "identity"."kyc_cases" ("id") ON DELETE SET NULL,
  "state"            text NOT NULL DEFAULT 'submitted' CHECK ("state" IN ('submitted', 'approved', 'rejected', 'expired')),
  "version"          integer NOT NULL DEFAULT 1 CHECK ("version" >= 1),
  "reason_code"      text CHECK ("reason_code" IS NULL OR "reason_code" ~ '^[a-z][a-z0-9_]{1,63}$'),
  "customer_note"    text CHECK ("customer_note" IS NULL OR char_length("customer_note") BETWEEN 1 AND 500),
  "note_visible"     boolean NOT NULL DEFAULT false,
  "decided_by"       text,
  "decided_at"       timestamptz,
  -- A case made by this migration for a record that existed before cases did.
  "backfilled"       boolean NOT NULL DEFAULT false,
  "created_at"       timestamptz NOT NULL DEFAULT now(),
  "updated_at"       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "kyc_cases_record_key" UNIQUE ("record_id"),
  CONSTRAINT "kyc_cases_reject_has_reason" CHECK ("state" <> 'rejected' OR "reason_code" IS NOT NULL OR "backfilled")
);
CREATE INDEX IF NOT EXISTS "kyc_cases_user_idx" ON "identity"."kyc_cases" ("user_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "kyc_cases_previous_idx" ON "identity"."kyc_cases" ("previous_case_id") WHERE "previous_case_id" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "identity"."kyc_case_events" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "case_id"      uuid NOT NULL REFERENCES "identity"."kyc_cases" ("id") ON DELETE CASCADE,
  "version"      integer NOT NULL CHECK ("version" >= 1),
  "state"        text NOT NULL CHECK ("state" IN ('submitted', 'approved', 'rejected', 'expired')),
  "reason_code"  text,
  "at"           timestamptz NOT NULL DEFAULT now(),
  "published_at" timestamptz,
  CONSTRAINT "kyc_case_events_version_key" UNIQUE ("case_id", "version")
);
CREATE INDEX IF NOT EXISTS "kyc_case_events_unpublished_idx"
  ON "identity"."kyc_case_events" ("at") WHERE "published_at" IS NULL;

-- Backfill: one case per existing record, a rejected one without a reason (it was rejected before reasons existed).
INSERT INTO "identity"."kyc_cases" ("user_id", "record_id", "state", "version", "decided_by", "decided_at", "backfilled", "created_at", "updated_at")
SELECT r."user_id", r."id",
       CASE r."status" WHEN 'pending' THEN 'submitted' ELSE r."status"::text END,
       CASE r."status" WHEN 'pending' THEN 1 ELSE 2 END,
       r."reviewed_by", r."reviewed_at", true, r."created_at", COALESCE(r."reviewed_at", r."created_at")
FROM "identity"."kyc_records" r
ON CONFLICT ("record_id") DO NOTHING;
INSERT INTO "identity"."kyc_case_events" ("case_id", "version", "state", "at", "published_at")
SELECT c."id", 1, 'submitted', c."created_at", now() FROM "identity"."kyc_cases" c
ON CONFLICT ("case_id", "version") DO NOTHING;
INSERT INTO "identity"."kyc_case_events" ("case_id", "version", "state", "at", "published_at")
SELECT c."id", 2, c."state", COALESCE(c."decided_at", c."updated_at"), now() FROM "identity"."kyc_cases" c WHERE c."version" = 2
ON CONFLICT ("case_id", "version") DO NOTHING;
