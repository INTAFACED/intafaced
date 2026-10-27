-- svc-notify · navigation metric counts (HM-navigation-04 search-miss counter; the receiver of HM-desks-02)
-- Reversal: 0036_notify_nav_metric_counts.down.sql
--
-- One row per kind and UTC day: how many times the customer app reported it. No account id, no query text and no per-event
-- row are stored, so a count can never say who searched or for what. The app sends each count once with no retry, so a
-- count is a lower bound.
CREATE TABLE IF NOT EXISTS notify.nav_metric_counts (
  kind text NOT NULL CHECK (kind IN ('search_miss')),
  day date NOT NULL,
  count bigint NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (kind, day)
);
