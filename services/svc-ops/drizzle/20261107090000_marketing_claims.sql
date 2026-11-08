-- svc-ops · the marketing claims evidence register (RC-more-catalogue-24, J-more-catalogue-14 #7)
-- Reversal: 20261107090000_marketing_claims.down.sql
--
-- A claim is recorded once under its business key (`claim:<hash>`) as a draft, with its evidence or none, and published
-- later by a DIFFERENT founder, only when it names evidence. The CHECKs hold the same rules whatever the code in front of
-- them does: a published claim has evidence, an approver and a time, and its approver is not its author. Every record,
-- publish, no-op and refused publish is appended to a log that refuses update and delete. No ledger entry; no money moves.
CREATE TABLE ops.marketing_claims (
 id uuid PRIMARY KEY,
 key text NOT NULL UNIQUE,
 topic text NOT NULL CHECK (char_length(topic) BETWEEN 1 AND 120),
 text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 300),
 evidence text CHECK (evidence IS NULL OR char_length(evidence) BETWEEN 1 AND 500),
 status text NOT NULL CHECK (status IN ('draft', 'published')),
 author_id text NOT NULL,
 created_at timestamptz NOT NULL,
 approver_id text,
 published_at timestamptz,
 CHECK (status <> 'draft' OR (approver_id IS NULL AND published_at IS NULL)),
 CHECK (status <> 'published' OR (evidence IS NOT NULL AND approver_id IS NOT NULL AND published_at IS NOT NULL)),
 CHECK (approver_id IS NULL OR approver_id <> author_id)
);
CREATE INDEX marketing_claims_newest ON ops.marketing_claims (created_at DESC, id);
CREATE TABLE ops.marketing_claim_log (
 seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 claim_id uuid NOT NULL REFERENCES ops.marketing_claims (id),
 op text NOT NULL CHECK (op IN ('record', 'publish')),
 outcome text NOT NULL CHECK (outcome IN ('created', 'published', 'noop', 'refused')),
 code text,
 actor_id text NOT NULL,
 logged_at timestamptz NOT NULL
);
CREATE TRIGGER marketing_claim_log_append_only BEFORE UPDATE OR DELETE ON ops.marketing_claim_log FOR EACH ROW EXECUTE FUNCTION ops.console_log_append_only();
