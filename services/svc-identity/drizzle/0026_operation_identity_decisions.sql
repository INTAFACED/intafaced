-- Permission decisions only. Payloads and all balances remain in their owners.
CREATE TABLE identity.operation_identity_decisions (
  service text NOT NULL CHECK (service IN ('svc-trade', 'svc-pay')),
  kind text NOT NULL,
  business_id text NOT NULL,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  grant_id uuid UNIQUE,
  decision jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (service, kind, business_id)
);
CREATE TRIGGER operation_identity_decisions_immutable
  BEFORE UPDATE OR DELETE ON identity.operation_identity_decisions
  FOR EACH ROW EXECUTE FUNCTION identity.founder_control_history_immutable();
