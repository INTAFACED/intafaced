-- svc-notify · the guest verification door (ADR 2026-10-22 §3.5, SP-tickets-01)
-- Reversal: 0037_notify_guest_verifications.down.sql
--
-- NOT tagged `intafaced:destructive`: it adds tables only.
--
-- svc-support asks for one email per link: the link opens the guest's support request. The link carries a token, so it is
-- never stored: a row keeps the token's id and expiry and the address it went to. Rows are tagged with the producer, and a
-- producer reads and erases only its own. This queue never creates an identity, an inbox row or a channel target, and it
-- shares no table with the outreach guest route (0009), so neither producer can read or erase the other's rows.

CREATE TABLE IF NOT EXISTS notify.guest_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  producer text NOT NULL CHECK (producer = 'svc-support'),
  business_key text NOT NULL CHECK (length(business_key) BETWEEN 1 AND 200),
  fingerprint text NOT NULL,
  guest_request_id uuid NOT NULL,
  recipient_email text CHECK (recipient_email IS NULL OR length(recipient_email) <= 320),
  token_id text NOT NULL CHECK (length(token_id) BETWEEN 8 AND 128),
  expires_at timestamptz NOT NULL,
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
  UNIQUE (producer, business_key),
  CHECK ((recipient_email IS NULL) = (erased_at IS NOT NULL)),
  CHECK ((status = 'accepted') = (accepted_at IS NOT NULL)),
  CHECK (accepted_at IS NULL OR attempted_at IS NOT NULL),
  CHECK (status = 'accepted' OR reference IS NULL),
  CHECK (reference IS NULL OR length(reference) <= 256),
  CHECK ((attempted_at IS NULL) = (claim_token IS NULL)),
  CHECK ((status = 'attempting') = (lease_until IS NOT NULL)),
  CHECK (status != 'queued' OR attempted_at IS NULL),
  CHECK (status NOT IN ('attempting','unresolved') OR attempted_at IS NOT NULL),
  CHECK ((status IN ('refused','unresolved')) = (code IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS guest_verifications_request_idx ON notify.guest_verifications (producer, guest_request_id);

-- One tombstone per erased guest request: later sends for it refuse guest.request_erased.
CREATE TABLE IF NOT EXISTS notify.guest_verification_erasures (
  producer text NOT NULL CHECK (producer = 'svc-support'),
  guest_request_id uuid NOT NULL,
  erased_count integer NOT NULL CHECK (erased_count >= 0),
  erased_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (producer, guest_request_id)
);

-- Sends per address per window, apart from the outreach route's windows so one producer cannot spend the other's budget.
CREATE TABLE IF NOT EXISTS notify.guest_verification_rate_windows (
  address_hash text NOT NULL,
  window_start bigint NOT NULL,
  attempts integer NOT NULL CHECK (attempts > 0),
  PRIMARY KEY (address_hash, window_start)
);
