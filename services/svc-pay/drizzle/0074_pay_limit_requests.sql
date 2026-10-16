-- W2c: a merchant's request for higher caps.
--
-- Stores the ask only. It does not write pay.control_merchant_profiles and it
-- does not change any cap the money path reads. A founder still changes caps
-- through the existing dual-control flow. No cap, fee or tier is seeded.

CREATE TABLE IF NOT EXISTS "pay"."control_limit_requests" (
  "request_id"   uuid PRIMARY KEY,
  "seq"          bigserial NOT NULL,
  "merchant_id"  uuid NOT NULL REFERENCES "pay"."merchants"("id"),
  "caps"         jsonb NOT NULL CONSTRAINT "control_limit_requests_caps_array" CHECK (jsonb_typeof("caps") = 'array' AND jsonb_array_length("caps") > 0),
  "reason"       text NOT NULL CONSTRAINT "control_limit_requests_reason_not_blank" CHECK (length(btrim("reason")) >= 3),
  "status"       text NOT NULL CONSTRAINT "control_limit_requests_status_pending" CHECK ("status" = 'pending'),
  "requested_by" text NOT NULL CONSTRAINT "control_limit_requests_actor_not_blank" CHECK (length(btrim("requested_by")) > 0),
  "created_at"   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "control_limit_requests_seq_idx" ON "pay"."control_limit_requests" ("seq");
-- One open request per merchant. A second insert while one is pending fails; the service returns the open row.
CREATE UNIQUE INDEX IF NOT EXISTS "control_limit_requests_one_open_idx"
  ON "pay"."control_limit_requests" ("merchant_id") WHERE "status" = 'pending';

-- The row is the ask the merchant sent. Caps inside it must not be edited in place.
DROP TRIGGER IF EXISTS "control_limit_requests_append_only_trg" ON "pay"."control_limit_requests";
CREATE TRIGGER "control_limit_requests_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pay"."control_limit_requests"
  FOR EACH ROW EXECUTE FUNCTION "pay"."control_append_only"();
