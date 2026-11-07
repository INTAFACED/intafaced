-- svc-notify · J-charts-desk-09 #7 watchlist alerts
-- Reversal: 20261107074033_notify_watchlist_alerts.down.sql
--
-- A watchlist alert is one price rule on every market of one of the person's watchlists. Each market gets its own price
-- alert (notify.price_alerts), stored in the same transaction as this row's `markets`, the markets it has already covered.
-- Each sweep reads the list again from identity (preferences.watchlistsFor) and adds an alert for any market added to the
-- list since, under the person's price-alert quota. A market taken off the list keeps its alert: the person manages it on
-- its own. `last_sync_code` names why the last sweep added nothing it should have (identity gave no answer, the list is gone,
-- the quota is full), so the page can say so; it is null when the last sweep had nothing to refuse.

CREATE TABLE IF NOT EXISTS "notify"."watchlist_alerts" (
  "id" uuid PRIMARY KEY,
  "user_id" text NOT NULL,
  "list_id" text NOT NULL,
  "list_name" text NOT NULL,
  "condition" text NOT NULL,
  "direction" text NOT NULL,
  "target_price" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "markets" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "last_sync_at" timestamptz,
  "last_sync_code" text,
  CONSTRAINT "watchlist_alerts_status_ck" CHECK ("status" IN ('active', 'stopped')),
  CONSTRAINT "watchlist_alerts_direction_ck" CHECK ("direction" IN ('above', 'below'))
);
CREATE INDEX IF NOT EXISTS "watchlist_alerts_user_idx" ON "notify"."watchlist_alerts" ("user_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "watchlist_alerts_active_idx" ON "notify"."watchlist_alerts" ("created_at") WHERE "status" = 'active';
