-- intafaced:destructive — reversal of 0027_auth_attempt_lockouts.sql; drops transient lockout counters only (no money, no credentials).

DROP TABLE IF EXISTS "identity"."auth_attempts";
