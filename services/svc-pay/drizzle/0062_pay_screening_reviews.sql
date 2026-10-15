-- Screening review holds no party names, registration numbers or wallet addresses.
-- Settlement and attempt identify the work, including a refused first admission.
CREATE TABLE pay.screening_reviews (
  settlement_id uuid NOT NULL REFERENCES pay.settlements(id),
  attempt integer NOT NULL CHECK(attempt >= 0),
  merchant_id uuid NOT NULL REFERENCES pay.merchants(id),
  provider text NOT NULL CHECK(provider ~ '^[a-z0-9_-]{1,64}$'),
  fixture boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  PRIMARY KEY(settlement_id,attempt)
);
CREATE INDEX screening_reviews_pending ON pay.screening_reviews(created_at,settlement_id,attempt) WHERE resolved_at IS NULL;
