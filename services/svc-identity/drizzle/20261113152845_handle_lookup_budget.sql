-- svc-identity · the shared per-person budget for looking people up by @handle, email or phone (#4689).
-- One row per person: the start of the current window and the lookups taken in it. Shared by every replica and kept
-- across restarts, so N replicas no longer give a person N budgets. No handle, email or phone looked up is stored.
-- Policy lives in src/handle-lookup.ts (`PgHandleLookupLimiter`). Reversal: the .down.sql of the same name.
CREATE TABLE IF NOT EXISTS "identity"."handle_lookup_budget" (
  "user_id"           uuid PRIMARY KEY REFERENCES "identity"."users" ("id") ON DELETE CASCADE,
  "window_started_at" timestamptz NOT NULL,
  "hits"              integer NOT NULL CHECK ("hits" >= 1)
);
