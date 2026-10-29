import { profileEnvFor } from '../owner-settings.mjs';

/**
 * `LOCAL_STACK_MINING_POOL_PUBLISHED=off` on a start or restart leaves every owner value blank, as a deployment that has
 * published nothing runs, so the overview and connection refusals are read in the running app (J-more-catalogue-05 #1, #2).
 */
export function miningPoolPublished() {
  const asked = process.env.LOCAL_STACK_MINING_POOL_PUBLISHED;
  if (asked === undefined) return true;
  if (asked === 'off') return false;
  throw new Error(`LOCAL_STACK_MINING_POOL_PUBLISHED is "${asked}"; leave it unset for the TEST values, or set it to off.`);
}

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
    ...(miningPoolPublished() ? profileEnvFor('mining-pool', 'dev') : {}),
  }),
});
