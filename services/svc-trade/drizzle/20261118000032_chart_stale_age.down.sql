-- intafaced:destructive — reversal of 20261118000032_chart_stale_age.sql drops the stale age. No money is in it: a blank
-- stale age already judges no stream stale and journals nothing, so the feed desk does that again after the drop.
ALTER TABLE trade.chart_owner_values DROP COLUMN IF EXISTS stale_age_seconds;
