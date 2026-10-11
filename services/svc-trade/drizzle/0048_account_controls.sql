-- Owned restriction policy and immutable admission evidence; no money book.
CREATE TABLE trade.account_restrictions (
  user_id uuid PRIMARY KEY,
  restricted boolean NOT NULL DEFAULT false,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0)
);
CREATE TABLE trade.account_control_history (
  audit_id uuid PRIMARY KEY,
  request_id uuid NOT NULL,
  target_user_id uuid NOT NULL,
  result jsonb NOT NULL,
  occurred_at timestamptz NOT NULL
);
CREATE INDEX account_control_history_target ON trade.account_control_history(target_user_id, occurred_at DESC, audit_id);
CREATE TABLE trade.account_control_requests (
  request_id uuid PRIMARY KEY,
  fingerprint text NOT NULL,
  result jsonb NOT NULL
);
CREATE TABLE trade.operation_intents (
  user_id uuid NOT NULL,
  business_id text NOT NULL,
  intent jsonb NOT NULL,
  payload jsonb NOT NULL,
  identity_requested boolean NOT NULL DEFAULT true CHECK (identity_requested),
  decision jsonb,
  admission jsonb,
  prepared_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id, business_id)
);
CREATE FUNCTION trade.account_control_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'immutable account control evidence' USING ERRCODE = '23514'; END;
$$;
CREATE TRIGGER account_control_history_immutable BEFORE UPDATE OR DELETE ON trade.account_control_history
FOR EACH ROW EXECUTE FUNCTION trade.account_control_immutable();
CREATE TRIGGER account_control_requests_immutable BEFORE UPDATE OR DELETE ON trade.account_control_requests
FOR EACH ROW EXECUTE FUNCTION trade.account_control_immutable();
CREATE FUNCTION trade.operation_intent_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.user_id <> OLD.user_id OR NEW.business_id <> OLD.business_id
    OR NEW.intent IS DISTINCT FROM OLD.intent OR NEW.payload IS DISTINCT FROM OLD.payload
    OR NEW.identity_requested IS DISTINCT FROM OLD.identity_requested OR NEW.prepared_at <> OLD.prepared_at
    OR (OLD.decision IS NOT NULL AND NEW.decision IS DISTINCT FROM OLD.decision)
    OR (OLD.admission IS NOT NULL AND NEW.admission IS DISTINCT FROM OLD.admission) THEN
    RAISE EXCEPTION 'immutable operation intent' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER operation_intent_immutable BEFORE UPDATE OR DELETE ON trade.operation_intents
FOR EACH ROW EXECUTE FUNCTION trade.operation_intent_immutable();
