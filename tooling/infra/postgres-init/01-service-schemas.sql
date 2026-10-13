-- INTAFACED · dev database bootstrap
--
-- Doctrine §2: "services never import each other's DB schemas".
-- We enforce that in the database itself, not just by convention:
--   one schema per service + one role per service, granted only its own schema.
-- A service that tries to read another service's tables gets a permission error
-- in dev, long before it becomes an architecture violation in prod.
--
-- Dev credentials only. Prod roles come from vault (§9 Security).

CREATE EXTENSION IF NOT EXISTS "citext";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_stat_statements";

DO $$
DECLARE
  svc text;
  services text[] := ARRAY[
    -- Phase 1 · THE CORE
    'identity', 'ledger', 'token',
    -- Phase 2 · TRADE
    'matching', 'trade',
    -- Phase 3 · PAY + P2P
    'pay', 'p2p',
    -- Phase 4 · BLUEPRINT
    'blueprint',
    -- Phase 5 · SURFACES
    'bank', 'launch', 'academy', 'market', 'mining_pool', 'agents', 'core_ops', 'ops', 'notify', 'support',
    -- Protocol Plane (v1.1 §17.5) — svc-dex absorbed into svc-protocol
    'chain', 'indexer', 'bridge', 'protocol'
  ];
BEGIN
  FOREACH svc IN ARRAY services LOOP
    -- role
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'svc_' || svc) THEN
      EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L', 'svc_' || svc, 'svc_' || svc);
    END IF;

    -- schema owned by that role
    EXECUTE format('CREATE SCHEMA IF NOT EXISTS %I AUTHORIZATION %I', svc, 'svc_' || svc);

    -- the service sees only its own schema
    EXECUTE format('ALTER ROLE %I SET search_path TO %I, public', 'svc_' || svc, svc);
    EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', 'svc_' || svc);

    -- test schema mirror, used by the drizzle test DB harness (§1 Testing)
    EXECUTE format('CREATE SCHEMA IF NOT EXISTS %I AUTHORIZATION %I', 'test_' || svc, 'svc_' || svc);
  END LOOP;
END
$$;

-- The operator/admin role (apps/admin, migrations, reconciliation jobs) sees everything.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'intafaced_ops') THEN
    CREATE ROLE intafaced_ops LOGIN PASSWORD 'intafaced_ops';
  END IF;
END
$$;

GRANT ALL ON DATABASE intafaced TO intafaced_ops;
