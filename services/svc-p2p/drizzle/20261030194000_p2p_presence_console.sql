-- P-ads-merchant-08 (J-p2p-05 #4): a merchant's presence (online, offline, or on a weekly schedule), and bulk ad actions
-- answered once per key. No balance is stored here.
--
-- `merchant_presence`: one row per person who set it; no row is `online`. `windows` is a list of
-- {"day": 1-7 (ISO, Monday first), "start": "HH:MM", "end": "HH:MM" or "24:00"} in the person's own `timezone`. An offline
-- maker's ads, or a scheduled one's outside every window, leave the board; open orders carry on.
-- `offer_bulk_runs`: one row per bulk action and key, holding each ad's own result, so a repeat with the same key answers
-- the same results and changes nothing.
-- Reversal: 20261030194000_p2p_presence_console.down.sql
CREATE TABLE IF NOT EXISTS "p2p"."merchant_presence" (
  "user_id" text PRIMARY KEY,
  "mode" text NOT NULL,
  "timezone" text NOT NULL DEFAULT 'UTC',
  "windows" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "merchant_presence_mode_ck" CHECK ("mode" IN ('online', 'offline', 'scheduled')),
  CONSTRAINT "merchant_presence_windows_ck" CHECK (jsonb_typeof("windows") = 'array')
);

-- Whether a weekly schedule is open at `at`, read in its own time zone.
CREATE OR REPLACE FUNCTION "p2p"."presence_open"(tz text, wins jsonb, at timestamptz) RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM jsonb_array_elements(wins) w
     WHERE (w->>'day')::int = extract(isodow FROM at AT TIME ZONE tz)::int
       AND (at AT TIME ZONE tz)::time >= (w->>'start')::time
       AND (at AT TIME ZONE tz)::time < (w->>'end')::time
  )
$$;

-- Whether a maker's ads are on the board at `at`: no presence row, or online, or inside a scheduled window.
CREATE OR REPLACE FUNCTION "p2p"."maker_on_board"(maker text, at timestamptz) RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (SELECT CASE mp."mode" WHEN 'online' THEN true WHEN 'offline' THEN false
                           ELSE "p2p"."presence_open"(mp."timezone", mp."windows", at) END
       FROM "p2p"."merchant_presence" mp WHERE mp."user_id" = maker),
    true)
$$;

CREATE TABLE IF NOT EXISTS "p2p"."offer_bulk_runs" (
  "maker_id" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "request_hash" text NOT NULL,
  "action" text NOT NULL,
  "results" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("maker_id", "idempotency_key"),
  CONSTRAINT "offer_bulk_runs_action_ck" CHECK ("action" IN ('pause', 'resume', 'remove'))
);
