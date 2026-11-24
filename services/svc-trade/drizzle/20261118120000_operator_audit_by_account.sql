-- J-cex-spot-18 #5 (row d115: every read logged where the customer sees it): a customer reads the operator audit rows
-- that name their own account, newest first. One index on the account and the time, so that read never scans the feed.
CREATE INDEX IF NOT EXISTS operator_audit_account_idx
  ON trade.operator_audit (account_id, occurred_at DESC, id DESC)
  WHERE account_id IS NOT NULL;
