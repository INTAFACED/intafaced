-- intafaced:destructive — reversal of 20261113152845_handle_lookup_budget.sql; drops transient lookup counters only (no money, no credentials). svc-identity then needs the process-local limiter back.
DROP TABLE IF EXISTS "identity"."handle_lookup_budget";
