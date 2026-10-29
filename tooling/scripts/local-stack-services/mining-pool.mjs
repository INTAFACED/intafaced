import { profileEnvFor } from '../owner-settings.mjs';

export default ({ c, secrets, dbUrl, urlOf, PORTS }) => ({
  // Share ingest and reads over its own schema. The pool fee and the PPLNS window are the owner's blank settings and
  // stay unset (the service refuses by name), and MINING_PAYOUT_INTERVAL_MS stays unset, so no epoch job pays anything.
  name: 'mining-pool',
  entry: 'server.js', // dist/index.js only re-exports; server.js listens
  env: () => ({
    ...c('svc-mining-pool', PORTS['mining-pool']),
    DATABASE_URL: dbUrl('svc_mining_pool', secrets),
    LEDGER_URL: urlOf('ledger'),
    // LOCAL TEST only, the labelled values in tooling/profiles/test-owner-values/mining-pool.json: the pool overview, the
    // host and port a miner copies, and the reachability test's limit, window and wait (J-more-catalogue-05 #1-#4).
    // Production stays blank and each read refuses by name (mining.overview_unset, mining.connection_unset,
    // mining.probe_limit_unset, mining.probe_timeout_unset).
    ...profileEnvFor('mining-pool', 'dev'),
  }),
});
