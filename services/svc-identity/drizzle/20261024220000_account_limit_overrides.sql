-- svc-identity · account limit overrides (J-ops-console-04 #12, OPS-accounts-desk-03). A founder sets a temporary
-- override of one rail's limit figures for one customer and asset; it ends at its stored expiry and the base limit (kept
-- by the service that enforces it) is back. Above the owner ceiling the other founder must approve. No money moves here.
-- Reversal: the .down.sql of the same name.
CREATE TABLE IF NOT EXISTS "identity"."account_limit_overrides" (
  "user_id" uuid NOT NULL REFERENCES "identity"."users"("id") ON DELETE CASCADE,
  "rail" text NOT NULL CHECK ("rail" IN ('withdrawal')),
  "asset_id" text NOT NULL CHECK ("asset_id" ~ '^[A-Z0-9]{1,16}$'),
  "version" bigint NOT NULL CHECK ("version" >= 1),
  -- Decimal strings in the asset's own units, above zero; null keeps the base figure.
  "per_tx" text CHECK ("per_tx" IS NULL OR ("per_tx" ~ '^(0|[1-9][0-9]{0,19})(\.[0-9]{1,18})?$' AND "per_tx" !~ '^0(\.0+)?$')),
  "rolling_24h" text CHECK ("rolling_24h" IS NULL OR ("rolling_24h" ~ '^(0|[1-9][0-9]{0,19})(\.[0-9]{1,18})?$' AND "rolling_24h" !~ '^0(\.0+)?$')),
  "expires_at" timestamptz NOT NULL,
  "set_by" uuid NOT NULL,
  "approved_by" uuid,
  "approval_id" text,
  "set_at" timestamptz NOT NULL,
  "reason" text NOT NULL CHECK (char_length("reason") BETWEEN 12 AND 255),
  "cleared_by" uuid,
  "cleared_at" timestamptz,
  PRIMARY KEY ("user_id", "rail", "asset_id"),
  CONSTRAINT "account_limit_overrides_figure_ck" CHECK ("per_tx" IS NOT NULL OR "rolling_24h" IS NOT NULL),
  CONSTRAINT "account_limit_overrides_expiry_ck" CHECK ("expires_at" > "set_at"),
  CONSTRAINT "account_limit_overrides_approval_ck" CHECK (
    ("approved_by" IS NULL) = ("approval_id" IS NULL) AND ("approved_by" IS NULL OR "approved_by" <> "set_by")
  ),
  CONSTRAINT "account_limit_overrides_clear_ck" CHECK (("cleared_by" IS NULL) = ("cleared_at" IS NULL))
);

-- Every attempt, refused ones included, under its request id; a retry of the same request id reads the stored answer.
CREATE TABLE IF NOT EXISTS "identity"."account_limit_events" (
  "audit_id" uuid PRIMARY KEY,
  "request_id" uuid NOT NULL,
  "actor_id" uuid,
  "user_id" uuid NOT NULL,
  "fingerprint" text NOT NULL,
  "result" jsonb NOT NULL,
  "stored" boolean NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "account_limit_events_request_idx"
  ON "identity"."account_limit_events" ("request_id") WHERE "stored";
CREATE INDEX IF NOT EXISTS "account_limit_events_user_idx"
  ON "identity"."account_limit_events" ("user_id", "created_at" DESC);
DROP TRIGGER IF EXISTS "account_limit_events_immutable" ON "identity"."account_limit_events";
CREATE TRIGGER "account_limit_events_immutable" BEFORE UPDATE OR DELETE ON "identity"."account_limit_events"
  FOR EACH ROW EXECUTE FUNCTION "identity"."founder_control_history_immutable"();
