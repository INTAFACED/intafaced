-- Charts module owner value: the stale age (C-ops-04; row d115, 17 Nov 2026: delayed and stale are the owner's two ages,
-- the same on every screen). Blank is NULL: "not set", never a default number. In seconds: a candle stream whose newest
-- tick is older than this reads stale, and the feed watcher journals a drop (J-charts-desk-18 #1 #2). While it is blank
-- no stream is judged stale and the watcher writes nothing. Scalars stay one append-only snapshot per version (0098).
-- Reversal: 20261118000032_chart_stale_age.down.sql
ALTER TABLE trade.chart_owner_values
  ADD COLUMN IF NOT EXISTS stale_age_seconds integer
    CHECK (stale_age_seconds IS NULL OR stale_age_seconds BETWEEN 1 AND 86400);
