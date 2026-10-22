-- svc-identity · bind an IP allowlist on an existing API key
-- Reversal: 0018_api_keys_ip_allowlist.down.sql
--
-- Empty list stays unrestricted. Non-empty list: exchange from a non-listed
-- or missing IP refuses (auth.ip_not_allowed). Bind is a later act — create
-- does not require IPs. Exact IPv4/IPv6 match after trim; no CIDR.

ALTER TABLE "identity"."api_keys"
  ADD COLUMN IF NOT EXISTS "ip_allowlist" text[] NOT NULL DEFAULT '{}';
