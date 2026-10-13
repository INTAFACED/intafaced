-- Outreach prospects are not verified platform channel targets. This owned
-- queue never creates an identity, an inbox row, or a channel_targets entry.
CREATE TABLE notify.guest_erased_submissions (
  submission_id uuid PRIMARY KEY,
  erased_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE notify.guest_erasure_requests (
  request_id uuid PRIMARY KEY,
  submission_id uuid NOT NULL,
  result jsonb NOT NULL
);
CREATE TABLE notify.guest_address_rate_windows (
  address_hash text NOT NULL,
  window_start bigint NOT NULL,
  attempts integer NOT NULL CHECK (attempts > 0),
  PRIMARY KEY(address_hash, window_start)
);
CREATE TABLE notify.guest_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_key text NOT NULL UNIQUE CHECK (length(business_key) BETWEEN 1 AND 200),
  fingerprint text NOT NULL,
  submission_id uuid NOT NULL,
  payload jsonb CHECK (payload IS NULL OR jsonb_typeof(payload) = 'object'),
  erased_at timestamptz,
  status text NOT NULL CHECK (status IN ('queued','attempting','accepted','refused','unresolved')),
  code text,
  reference text,
  attempted_at timestamptz,
  accepted_at timestamptz,
  claim_token uuid,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((payload IS NULL) = (erased_at IS NOT NULL)),
  CHECK ((status = 'accepted') = (accepted_at IS NOT NULL)),
  CHECK (accepted_at IS NULL OR attempted_at IS NOT NULL),
  CHECK (status = 'accepted' OR reference IS NULL),
  CHECK (reference IS NULL OR length(reference) <= 256),
  CHECK ((attempted_at IS NULL) = (claim_token IS NULL)),
  CHECK ((status = 'attempting') = (lease_until IS NOT NULL)),
  CHECK (status != 'queued' OR attempted_at IS NULL),
  CHECK (status NOT IN ('attempting','unresolved') OR attempted_at IS NOT NULL),
  CHECK (status NOT IN ('refused','unresolved') OR code IS NOT NULL),
  CHECK (status NOT IN ('queued','attempting','accepted') OR code IS NULL)
);
CREATE INDEX guest_notifications_submission_idx ON notify.guest_notifications(submission_id);

CREATE FUNCTION notify.guest_notification_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE erasing boolean;
BEGIN
  erasing := OLD.erased_at IS NULL AND NEW.erased_at IS NOT NULL AND NEW.payload IS NULL
    AND EXISTS (SELECT 1 FROM notify.guest_erased_submissions WHERE submission_id = OLD.submission_id);
  IF TG_OP = 'DELETE' OR OLD.id IS DISTINCT FROM NEW.id
    OR OLD.business_key IS DISTINCT FROM NEW.business_key
    OR OLD.fingerprint IS DISTINCT FROM NEW.fingerprint
    OR OLD.submission_id IS DISTINCT FROM NEW.submission_id
    OR (OLD.payload IS DISTINCT FROM NEW.payload AND NOT erasing)
    OR (OLD.erased_at IS DISTINCT FROM NEW.erased_at AND NOT erasing)
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
    OR (OLD.attempted_at IS NOT NULL AND OLD.attempted_at IS DISTINCT FROM NEW.attempted_at)
    OR (OLD.attempted_at IS NOT NULL AND OLD.claim_token IS DISTINCT FROM NEW.claim_token)
    OR ((OLD.status IN ('accepted','unresolved') OR OLD.status = 'refused' AND OLD.attempted_at IS NOT NULL) AND
      ROW(OLD.status,OLD.code,OLD.attempted_at,OLD.accepted_at,OLD.claim_token,OLD.lease_until)
      IS DISTINCT FROM ROW(NEW.status,NEW.code,NEW.attempted_at,NEW.accepted_at,NEW.claim_token,NEW.lease_until))
    OR ((OLD.status IN ('accepted','unresolved') OR OLD.status = 'refused' AND OLD.attempted_at IS NOT NULL)
      AND OLD.reference IS DISTINCT FROM NEW.reference AND NOT erasing)
  THEN RAISE EXCEPTION 'Guest notification original request and terminal outcome are immutable' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guest_notification_immutable BEFORE UPDATE OR DELETE ON notify.guest_notifications
  FOR EACH ROW EXECUTE FUNCTION notify.guest_notification_immutable();
CREATE FUNCTION notify.guest_erasure_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Guest erasure evidence is immutable' USING ERRCODE = '23514'; END $$;
CREATE TRIGGER guest_erased_submission_immutable BEFORE UPDATE OR DELETE ON notify.guest_erased_submissions
  FOR EACH ROW EXECUTE FUNCTION notify.guest_erasure_immutable();
CREATE TRIGGER guest_erasure_request_immutable BEFORE UPDATE OR DELETE ON notify.guest_erasure_requests
  FOR EACH ROW EXECUTE FUNCTION notify.guest_erasure_immutable();
