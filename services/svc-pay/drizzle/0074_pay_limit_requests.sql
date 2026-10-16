-- W2c: a merchant's request for higher caps.
--
-- Stores the ask only. It does not write pay.control_merchant_profiles and it
-- does not change any cap the money path reads. A founder still changes caps
-- through the existing dual-control flow. No cap, fee or tier is seeded.
--
-- A row is born pending. It may move once, to withdrawn (the merchant took it
-- back) or closed (a founder closed it, or a confirmed cap change closed it).
-- Every other column stays as it was written. A second move is refused.

CREATE TABLE IF NOT EXISTS "pay"."control_limit_requests" (
  "request_id"   uuid PRIMARY KEY,
  "seq"          bigserial NOT NULL,
  "merchant_id"  uuid NOT NULL REFERENCES "pay"."merchants"("id"),
  "caps"         jsonb NOT NULL CONSTRAINT "control_limit_requests_caps_array" CHECK (jsonb_typeof("caps") = 'array' AND jsonb_array_length("caps") > 0),
  "reason"       text NOT NULL CONSTRAINT "control_limit_requests_reason_bounds" CHECK (length(btrim("reason")) >= 3 AND length("reason") <= 500),
  "status"       text NOT NULL CONSTRAINT "control_limit_requests_status_known" CHECK ("status" IN ('pending', 'withdrawn', 'closed')),
  "requested_by" text NOT NULL CONSTRAINT "control_limit_requests_requested_by_present" CHECK ("requested_by" IS NOT NULL AND length(btrim("requested_by")) > 0),
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  "closed_at"    timestamptz,
  "closed_by"    text,
  "close_reason" text,
  CONSTRAINT "control_limit_requests_terminal_fields" CHECK (
    ("status" = 'pending' AND "closed_at" IS NULL AND "closed_by" IS NULL AND "close_reason" IS NULL)
    OR (
      "status" IN ('withdrawn', 'closed')
      AND "closed_at" IS NOT NULL
      AND "closed_by" IS NOT NULL AND length(btrim("closed_by")) > 0
      AND "close_reason" IS NOT NULL AND length(btrim("close_reason")) >= 3 AND length("close_reason") <= 500
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "control_limit_requests_seq_idx" ON "pay"."control_limit_requests" ("seq");
-- One open request per merchant. A withdrawn or closed row does not hold the slot.
CREATE UNIQUE INDEX IF NOT EXISTS "control_limit_requests_one_open_idx"
  ON "pay"."control_limit_requests" ("merchant_id") WHERE "status" = 'pending';

-- Same shape as pay.control_pricing_rules_immutable: one named transition, nothing else.
CREATE OR REPLACE FUNCTION "pay"."control_limit_requests_close_once"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD."status" = 'pending'
     AND NEW."status" IN ('withdrawn', 'closed')
     AND (to_jsonb(NEW) - 'status' - 'closed_at' - 'closed_by' - 'close_reason')
         = (to_jsonb(OLD) - 'status' - 'closed_at' - 'closed_by' - 'close_reason')
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'pay.control_limit_requests is immutable: % is not permitted. A pending ask may move to withdrawn or closed once.', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS "control_limit_requests_append_only_trg" ON "pay"."control_limit_requests";
DROP TRIGGER IF EXISTS "control_limit_requests_close_once_trg" ON "pay"."control_limit_requests";
CREATE TRIGGER "control_limit_requests_close_once_trg"
  BEFORE UPDATE OR DELETE ON "pay"."control_limit_requests"
  FOR EACH ROW EXECUTE FUNCTION "pay"."control_limit_requests_close_once"();
