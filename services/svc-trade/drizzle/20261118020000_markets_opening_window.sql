-- J-cex-spot-14 #7 (SP-markets-data-02): a new listing has an opening window. Until it ends, the order door takes limit
-- orders only and refuses a market or conditional order with `trade.opening_window`. A market listed before windows
-- existed has none (null); a window that has ended no longer restricts anything.
ALTER TABLE trade.markets
  ADD COLUMN IF NOT EXISTS opening_window_ends_at timestamptz;
