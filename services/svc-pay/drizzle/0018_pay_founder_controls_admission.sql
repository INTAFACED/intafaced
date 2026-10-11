ALTER TABLE pay.merchants ADD COLUMN operations_control_version bigint NOT NULL DEFAULT 0;
ALTER TABLE pay.merchants ADD COLUMN operations_restricted boolean NOT NULL DEFAULT false;
ALTER TABLE pay.merchants ADD COLUMN operations_restore_status pay.merchant_status;
UPDATE pay.merchants SET operations_restricted=true WHERE status IN ('suspended','closed');
CREATE TABLE pay.account_control_audit (
 id uuid PRIMARY KEY, sequence bigserial NOT NULL UNIQUE, request_id uuid NOT NULL,
 actor_user_id uuid, merchant_id uuid NOT NULL, fingerprint text NOT NULL, result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pay_account_control_history ON pay.account_control_audit(merchant_id,sequence DESC);
CREATE TABLE pay.account_control_requests (request_id uuid PRIMARY KEY,actor_key text NOT NULL,fingerprint text NOT NULL,result jsonb NOT NULL);
CREATE TABLE pay.payout_admissions (
 id uuid PRIMARY KEY,settlement_id uuid NOT NULL REFERENCES pay.settlements(id),
 merchant_id uuid NOT NULL REFERENCES pay.merchants(id),merchant_user_id uuid NOT NULL,
 attempt integer NOT NULL CHECK(attempt>=0),business_id text NOT NULL UNIQUE,
 net numeric(38,18) NOT NULL CHECK(net>0),asset_id text NOT NULL,rail_id text NOT NULL,
 destination_kind text NOT NULL,destination_ref text NOT NULL,"window" text NOT NULL,
 admitted_at timestamptz NOT NULL DEFAULT now(),merchant_control_version bigint NOT NULL,
 identity_intent jsonb,UNIQUE(settlement_id,attempt)
);
CREATE TABLE pay.payout_outcomes (
 id bigserial PRIMARY KEY,admission_id uuid NOT NULL REFERENCES pay.payout_admissions(id),
 kind text NOT NULL CHECK(kind IN ('rail_accepted','rail_refused','settled','reversed','identity_requested','identity_granted','identity_cancelled')),
 payload jsonb NOT NULL,occurred_at timestamptz NOT NULL DEFAULT now(),UNIQUE(admission_id,kind)
);
CREATE TABLE pay.payment_admissions (
 business_id text PRIMARY KEY,payment_id uuid NOT NULL,merchant_id uuid NOT NULL REFERENCES pay.merchants(id),
 merchant_control_version bigint NOT NULL,intent jsonb NOT NULL,payload jsonb NOT NULL,
 prepared_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE pay.payment_admission_outcomes (
 id bigserial PRIMARY KEY,business_id text NOT NULL REFERENCES pay.payment_admissions(business_id),
 kind text NOT NULL CHECK(kind IN('identity_requested','identity_granted','identity_cancelled')),
 payload jsonb NOT NULL,occurred_at timestamptz NOT NULL DEFAULT now(),UNIQUE(business_id,kind)
);
CREATE UNIQUE INDEX pay_payout_identity_terminal ON pay.payout_outcomes(admission_id) WHERE kind IN('identity_granted','identity_cancelled');
CREATE UNIQUE INDEX pay_payout_rail_terminal ON pay.payout_outcomes(admission_id) WHERE kind IN('rail_accepted','rail_refused');
CREATE UNIQUE INDEX pay_payment_identity_terminal ON pay.payment_admission_outcomes(business_id) WHERE kind IN('identity_granted','identity_cancelled');
CREATE FUNCTION pay.founder_control_records_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'pay.control_record_immutable'; END; $$;
CREATE TRIGGER pay_control_audit_immutable BEFORE UPDATE OR DELETE ON pay.account_control_audit FOR EACH ROW EXECUTE FUNCTION pay.founder_control_records_immutable();
CREATE TRIGGER pay_control_requests_immutable BEFORE UPDATE OR DELETE ON pay.account_control_requests FOR EACH ROW EXECUTE FUNCTION pay.founder_control_records_immutable();
CREATE TRIGGER pay_payout_admission_immutable BEFORE UPDATE OR DELETE ON pay.payout_admissions FOR EACH ROW EXECUTE FUNCTION pay.founder_control_records_immutable();
CREATE TRIGGER pay_payout_outcomes_immutable BEFORE UPDATE OR DELETE ON pay.payout_outcomes FOR EACH ROW EXECUTE FUNCTION pay.founder_control_records_immutable();
CREATE TRIGGER pay_payment_admissions_immutable BEFORE UPDATE OR DELETE ON pay.payment_admissions FOR EACH ROW EXECUTE FUNCTION pay.founder_control_records_immutable();
CREATE TRIGGER pay_payment_admission_outcomes_immutable BEFORE UPDATE OR DELETE ON pay.payment_admission_outcomes FOR EACH ROW EXECUTE FUNCTION pay.founder_control_records_immutable();
