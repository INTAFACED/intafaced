-- J-developer-15 #4 (DV-console-01): developer-area roles in an organisation. An organisation key records its
-- organisation, so the organisation's owner and its key admins can see and revoke it. A member holds at most one
-- developer role; which roles exist is the owner value IDENTITY_DEVELOPER_ROLES (blank: roles not set). Each role
-- change keeps its request id, so a repeat is a no-op and the same id for a different change refuses.
ALTER TABLE "identity"."api_keys" ADD COLUMN IF NOT EXISTS "org_id" uuid REFERENCES "identity"."organizations" ("id");
CREATE INDEX IF NOT EXISTS "api_keys_org_idx" ON "identity"."api_keys" ("org_id") WHERE "org_id" IS NOT NULL;
CREATE TABLE IF NOT EXISTS "identity"."org_developer_roles" (
  "org_id" uuid NOT NULL REFERENCES "identity"."organizations" ("id"),
  "user_id" uuid NOT NULL,
  "role" text NOT NULL CHECK ("role" IN ('keys_admin', 'keys_read')),
  "updated_by" uuid NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("org_id", "user_id")
);
CREATE TABLE IF NOT EXISTS "identity"."org_developer_role_changes" (
  "org_id" uuid NOT NULL REFERENCES "identity"."organizations" ("id"),
  "request_id" text NOT NULL,
  "user_id" uuid NOT NULL,
  "role" text CHECK ("role" IN ('keys_admin', 'keys_read')),
  "actor_id" uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("org_id", "request_id")
);
