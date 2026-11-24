-- J-cex-spot-14 #6 (SP-developer-status-01): a TEST schedule, open one minute a week (Sunday 00:00 to 00:01 UTC), so the
-- local test stack can list one TEST market whose session is shut now, with a real next opening. The value is added on
-- its own: Postgres does not let a new enum value be used in the transaction that adds it, so the rule that only a TEST
-- listing may carry it is the next migration.
ALTER TYPE trade.trading_schedule ADD VALUE IF NOT EXISTS 'test-sunday-minute';
