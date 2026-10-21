-- trade.futures · versioned risk agreements and margin terms, acceptances, and derivatives eligibility.
-- Reversal: 0082_risk_agreements_eligibility.down.sql
--
-- D-account-07 (risk agreements, margin terms of use, derivatives eligibility with suitability).
--
--   · A risk agreement or margin terms document is a VERSION per kind. A version is published once, with one text
--     per jurisdiction, and is never edited: the tables are append-only, so a change is a new version.
--     No row means "nothing published" and futures opens refuse. This migration writes no agreement text.
--   · An acceptance is one row per (user, kind, version). It records the time and the id of the jurisdiction text
--     the user was shown. Acceptances stay linked to their version when a newer one is published.
--   · Eligibility rules are an owner publication (questions, answers that count, pass mark, minimum verification
--     tier), versioned append-only. No row means the quiz cannot pass. No default is written here.
--   · An assessment is a user's answers, score and result against one rule version. The user's retry key is the
--     business key (user, submission id).
--
-- Every statement is idempotent / re-runnable.

CREATE TABLE IF NOT EXISTS "trade"."risk_agreement_versions" (
  kind text NOT NULL CHECK (kind IN ('derivatives_risk', 'margin_terms')),
  version bigint NOT NULL CHECK (version >= 1),
  operator_id text NOT NULL,
  approver_id text NOT NULL,
  approval_id text NOT NULL,
  reason text NOT NULL,
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (kind, version)
);

DROP TRIGGER IF EXISTS risk_agreement_versions_append_only ON "trade"."risk_agreement_versions";
CREATE TRIGGER risk_agreement_versions_append_only
  BEFORE UPDATE OR DELETE ON "trade"."risk_agreement_versions"
  FOR EACH ROW EXECUTE FUNCTION trade.operator_append_only();

-- One owner-supplied text per jurisdiction per version. A jurisdiction with no row here is refused.
CREATE TABLE IF NOT EXISTS "trade"."risk_agreement_texts" (
  kind text NOT NULL,
  version bigint NOT NULL,
  region text NOT NULL CHECK (region = upper(btrim(region)) AND length(region) BETWEEN 1 AND 16),
  text_id text NOT NULL,
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  body text NOT NULL CHECK (length(btrim(body)) > 0),
  body_sha256 text NOT NULL,
  PRIMARY KEY (kind, version, region),
  UNIQUE (text_id),
  FOREIGN KEY (kind, version) REFERENCES "trade"."risk_agreement_versions" (kind, version)
);

DROP TRIGGER IF EXISTS risk_agreement_texts_append_only ON "trade"."risk_agreement_texts";
CREATE TRIGGER risk_agreement_texts_append_only
  BEFORE UPDATE OR DELETE ON "trade"."risk_agreement_texts"
  FOR EACH ROW EXECUTE FUNCTION trade.operator_append_only();

-- Idempotent on (user, kind, version): a repeat acceptance keeps the first row and its time.
CREATE TABLE IF NOT EXISTS "trade"."risk_agreement_acceptances" (
  user_id uuid NOT NULL,
  kind text NOT NULL,
  version bigint NOT NULL,
  region text NOT NULL,
  text_id text NOT NULL REFERENCES "trade"."risk_agreement_texts" (text_id),
  accepted_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, kind, version),
  FOREIGN KEY (kind, version) REFERENCES "trade"."risk_agreement_versions" (kind, version)
);

CREATE INDEX IF NOT EXISTS risk_agreement_acceptances_feed_idx
  ON "trade"."risk_agreement_acceptances" (accepted_at, user_id, kind, version);

DROP TRIGGER IF EXISTS risk_agreement_acceptances_append_only ON "trade"."risk_agreement_acceptances";
CREATE TRIGGER risk_agreement_acceptances_append_only
  BEFORE UPDATE OR DELETE ON "trade"."risk_agreement_acceptances"
  FOR EACH ROW EXECUTE FUNCTION trade.operator_append_only();

-- Owner eligibility rules. Latest version wins. A missing row is blank: the quiz cannot pass.
CREATE TABLE IF NOT EXISTS "trade"."derivatives_eligibility_rules" (
  version bigint PRIMARY KEY CHECK (version >= 1),
  questions jsonb NOT NULL CHECK (jsonb_typeof(questions) = 'array' AND jsonb_array_length(questions) >= 1),
  pass_mark integer NOT NULL CHECK (pass_mark >= 1),
  min_kyc_tier text NOT NULL CHECK (min_kyc_tier IN ('none', 'basic', 'full', 'institutional')),
  operator_id text NOT NULL,
  approver_id text NOT NULL,
  approval_id text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

DROP TRIGGER IF EXISTS derivatives_eligibility_rules_append_only ON "trade"."derivatives_eligibility_rules";
CREATE TRIGGER derivatives_eligibility_rules_append_only
  BEFORE UPDATE OR DELETE ON "trade"."derivatives_eligibility_rules"
  FOR EACH ROW EXECUTE FUNCTION trade.operator_append_only();

CREATE TABLE IF NOT EXISTS "trade"."derivatives_eligibility_assessments" (
  user_id uuid NOT NULL,
  submission_id text NOT NULL CHECK (length(submission_id) BETWEEN 1 AND 64),
  rule_version bigint NOT NULL REFERENCES "trade"."derivatives_eligibility_rules" (version),
  answers jsonb NOT NULL CHECK (jsonb_typeof(answers) = 'object'),
  answers_fingerprint text NOT NULL,
  score integer NOT NULL CHECK (score >= 0),
  pass_mark integer NOT NULL CHECK (pass_mark >= 1),
  passed boolean NOT NULL,
  assessed_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, submission_id)
);

CREATE INDEX IF NOT EXISTS derivatives_eligibility_assessments_latest_idx
  ON "trade"."derivatives_eligibility_assessments" (user_id, rule_version, assessed_at DESC);

DROP TRIGGER IF EXISTS derivatives_eligibility_assessments_append_only ON "trade"."derivatives_eligibility_assessments";
CREATE TRIGGER derivatives_eligibility_assessments_append_only
  BEFORE UPDATE OR DELETE ON "trade"."derivatives_eligibility_assessments"
  FOR EACH ROW EXECUTE FUNCTION trade.operator_append_only();
