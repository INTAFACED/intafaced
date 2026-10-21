-- Protocol listing overrides for the Protocol ops desk (D-order-controls-04).
-- Reversal: 0011_protocol_listing.down.sql
--
-- A hide or delist is a LISTING decision, not an on-chain pause: pools have no admin and no pause by design. These
-- tables say which pool or market INTAFACED does not list, who signed it and under which policy. They hold no balance
-- and no key, and nothing here can move or freeze anyone's funds.
CREATE TABLE ops.protocol_listing_overrides (
 kind text NOT NULL CHECK(kind IN ('pool','market')),
 target_id text NOT NULL CHECK(length(target_id) BETWEEN 1 AND 200),
 state text NOT NULL CHECK(state IN ('hidden','visible')),
 reason_code text,
 reason text,
 approval_id text NOT NULL,
 policy_version text NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (kind, target_id)
);
-- Append-only. The key is `<action>:<targetId>:<approvalId>`, so a retry with the same approval returns the stored result.
CREATE TABLE ops.protocol_listing_decisions (
 idempotency_key text PRIMARY KEY CHECK(length(idempotency_key) BETWEEN 8 AND 400),
 action text NOT NULL CHECK(action IN ('protocol.pool.hide','protocol.pool.restore','protocol.market.delist','protocol.market.restore')),
 kind text NOT NULL CHECK(kind IN ('pool','market')),
 target_id text NOT NULL,
 outcome text NOT NULL CHECK(outcome IN ('applied','noop')),
 note text,
 reason_code text,
 reason text,
 approval_id text NOT NULL,
 requester_id text NOT NULL,
 approver_id text NOT NULL,
 policy_version text NOT NULL,
 decided_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX protocol_listing_decisions_target_idx ON ops.protocol_listing_decisions (kind, target_id, decided_at);
CREATE FUNCTION ops.protocol_listing_decisions_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'ops.protocol_listing_decision_immutable';
END $$;
CREATE TRIGGER protocol_listing_decisions_append_only BEFORE UPDATE OR DELETE ON ops.protocol_listing_decisions FOR EACH ROW EXECUTE FUNCTION ops.protocol_listing_decisions_append_only();
