-- PP-send-request-13 (J-pay-05 #4, #5): reminders counted in the owner's window, and a payer's report and block on a request.
-- A reminder row now records when it was asked for, so the owner's cap per window can be counted. Rows from before this
-- migration take the migration's time, which only ever makes the window stricter for them.
ALTER TABLE "bank"."personal_request_reminds" ADD COLUMN IF NOT EXISTS "created_at" timestamptz NOT NULL DEFAULT now();

-- One report per request, keyed `report:<requestId>`: the safety case the person asked to pay filed when they declined it.
-- It holds no amount and moves nothing.
CREATE TABLE IF NOT EXISTS "bank"."personal_request_reports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "key" text NOT NULL UNIQUE,
  "request_id" uuid NOT NULL UNIQUE REFERENCES "bank"."personal_requests" ("id"),
  "reporter_user_id" text NOT NULL,
  "reported_user_id" text NOT NULL,
  "reason" text NOT NULL,
  "state" text NOT NULL DEFAULT 'open',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "personal_request_reports_reason_ck" CHECK ("reason" IN ('scam', 'spam', 'harassment', 'other')),
  CONSTRAINT "personal_request_reports_state_ck" CHECK ("state" IN ('open', 'closed'))
);

-- A person who blocked another for requests, keyed `block:<userId>:<blockedUserId>`: the blocked person can no longer ask
-- them for money. Only the person who blocked reads it.
CREATE TABLE IF NOT EXISTS "bank"."personal_request_blocks" (
  "key" text PRIMARY KEY,
  "user_id" text NOT NULL,
  "blocked_user_id" text NOT NULL,
  "report_id" uuid REFERENCES "bank"."personal_request_reports" ("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "personal_request_blocks_pair_uq" UNIQUE ("user_id", "blocked_user_id")
);
