-- Original minimal packet is immutable; receipts can be reconfirmed independently.
CREATE TABLE ops.crm_erasure_publications (
 intent_id uuid PRIMARY KEY REFERENCES ops.crm_erasure_intents(id),
 body text NOT NULL,
 digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
 receipt jsonb,
 prepared_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION ops.crm_publication_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.intent_id<>OLD.intent_id OR NEW.body<>OLD.body OR NEW.digest<>OLD.digest OR NEW.prepared_at<>OLD.prepared_at THEN
  RAISE EXCEPTION 'ops.crm.publication_immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER crm_publication_immutable BEFORE UPDATE ON ops.crm_erasure_publications FOR EACH ROW EXECUTE FUNCTION ops.crm_publication_immutable();
