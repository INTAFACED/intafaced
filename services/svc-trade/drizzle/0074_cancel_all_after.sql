-- trade.cancel_all_after · the dead-man switch: one countdown per user, durable across a restart
-- Reversal: 0074_cancel_all_after.down.sql
--
-- A trader arms a countdown and keeps re-arming it while their connection is alive. When the deadline passes
-- with no re-arm, a sweep cancels every open spot order of that user, as the caller who armed it. The caller's
-- own claims (scopes, session, tier; never a token or secret) are stored with the countdown, exactly as a
-- bracket stores its place grant, and arming is refused unless the credential outlives the deadline, so the
-- sweep never needs authority it was not given. The row is removed once the cancel pass has finished; a pass
-- that could not finish (an unresolved hold) leaves the row and is retried.

CREATE TABLE IF NOT EXISTS "trade"."cancel_all_after" (
  "user_id"          uuid PRIMARY KEY,
  "timeout_sec"      integer     NOT NULL,
  "deadline_at"      timestamptz NOT NULL,
  "grant_claims"     jsonb       NOT NULL,
  "grant_expires_at" timestamptz NOT NULL,
  "armed_at"         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "cancel_all_after_timeout_ck" CHECK ("timeout_sec" > 0),
  CONSTRAINT "cancel_all_after_grant_ck" CHECK ("grant_expires_at" >= "deadline_at")
);

CREATE INDEX IF NOT EXISTS "cancel_all_after_deadline_idx" ON "trade"."cancel_all_after" ("deadline_at");
