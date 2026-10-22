-- Reverses 0072_org_security_policy.sql. Policies, their history and org session activity are dropped; no policy applies.
DROP TABLE IF EXISTS "identity"."org_session_activity";
DROP TABLE IF EXISTS "identity"."org_security_policy_history";
DROP TABLE IF EXISTS "identity"."org_security_policies";
