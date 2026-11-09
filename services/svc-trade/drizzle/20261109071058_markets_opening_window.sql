-- J-cex-spot-14 #7 (SP-markets-data-02): a newly opened market can sit in an opening window, in which a market order is
-- refused with the window's reason and a limit order is accepted. The listing keeps the time the window ends; null means
-- no window. Only an active listing trades, so the window is read only there.
ALTER TABLE trade.markets
  ADD COLUMN IF NOT EXISTS opening_window_ends_at timestamptz;
