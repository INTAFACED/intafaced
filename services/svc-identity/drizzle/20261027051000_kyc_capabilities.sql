-- svc-identity · KYC capabilities (I-kyc-compliance-07, J-identity-08 #6). What a person's verification lets them do,
-- one row per capability: custody, transfer and trade, crypto and fiat. A request marks the capabilities the owner maps
-- to its level pending; the approval makes them active in its own transaction; a reject puts a pending one back to
-- unrequested. inactive is terminal: compliance sets it with a reason code under a four-eyes approval, and no approval
-- or request turns it back on. A capability with no row reads unrequested. Every change appends one history row.
-- Reversal: the .down.sql of the same name.
CREATE TABLE IF NOT EXISTS "identity"."kyc_capabilities" (
  "user_id"     uuid NOT NULL REFERENCES "identity"."users" ("id") ON DELETE CASCADE,
  "capability"  text NOT NULL CHECK ("capability" IN ('custody_crypto', 'custody_fiat', 'transfer_crypto', 'transfer_fiat', 'trade_crypto')),
  "state"       text NOT NULL CHECK ("state" IN ('unrequested', 'pending', 'active', 'inactive')),
  "case_id"     uuid REFERENCES "identity"."kyc_cases" ("id") ON DELETE SET NULL,
  "decided_by"  text,
  "reason_code" text CHECK ("reason_code" IS NULL OR "reason_code" ~ '^[a-z][a-z0-9_]{1,63}$'),
  "version"     integer NOT NULL DEFAULT 1 CHECK ("version" >= 1),
  "at"          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "capability"),
  CONSTRAINT "kyc_capabilities_inactive_has_reason" CHECK ("state" <> 'inactive' OR ("reason_code" IS NOT NULL AND "decided_by" IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS "identity"."kyc_capability_events" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"     uuid NOT NULL REFERENCES "identity"."users" ("id") ON DELETE CASCADE,
  "capability"  text NOT NULL,
  "version"     integer NOT NULL CHECK ("version" >= 1),
  "state"       text NOT NULL CHECK ("state" IN ('unrequested', 'pending', 'active', 'inactive')),
  "case_id"     uuid,
  "decided_by"  text,
  "reason_code" text,
  "at"          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "kyc_capability_events_version_key" UNIQUE ("user_id", "capability", "version")
);
