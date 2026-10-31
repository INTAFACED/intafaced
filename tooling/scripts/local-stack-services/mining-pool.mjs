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

/**
 * `LOCAL_STACK_MINING_POOL_POW=off` on a start or restart leaves the three proof-of-work values blank while the rest of
 * the TEST profile stays, so the blank refusal (`mining.pow_spec_unset`) is read in the running app (J-more-catalogue-05 #7).
 */
export function miningPoolPow() {
  const asked = process.env.LOCAL_STACK_MINING_POOL_POW;
  if (asked === undefined) return true;
  if (asked === 'off') return false;
  throw new Error(`LOCAL_STACK_MINING_POOL_POW is "${asked}"; leave it unset for the TEST values, or set it to off.`);
}

/**
 * `LOCAL_STACK_MINING_POOL_PROBE_TARGET=127.0.0.1:<port>` on a restart points the pool's host and port at a local
 * listener a journey starts, so the reachability test's "Timed out" and "Not reached" are each produced on purpose
 * (J-more-catalogue-05 #3). Loopback only; unset keeps the TEST profile's documentation address.
 */
export function miningPoolProbeTarget() {
  const asked = process.env.LOCAL_STACK_MINING_POOL_PROBE_TARGET;
  if (asked === undefined) return {};
  const match = /^127\.0\.0\.1:(\d{1,5})$/.exec(asked);
  const port = match ? Number(match[1]) : 0;
  if (port < 1 || port > 65535) {
    throw new Error(`LOCAL_STACK_MINING_POOL_PROBE_TARGET is "${asked}"; set it to 127.0.0.1:<port>, or leave it unset.`);
  }
  return { MINING_POOL_HOST: '127.0.0.1', MINING_POOL_PORT: String(port) };
}

const POW_KEYS = ['MINING_POW_DIMENSION', 'MINING_POW_TARGET_BITS', 'MINING_POW_TESTNET'];

function published() {
  if (!miningPoolPublished()) return {};
  const values = { ...profileEnvFor('mining-pool', 'dev'), ...miningPoolProbeTarget() };
  if (!miningPoolPow()) for (const key of POW_KEYS) delete values[key];
  return values;
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
    // mining.probe_limit_unset, mining.probe_timeout_unset). The TEST testnet proof-of-work parameters too (#7): a share
    // must carry valid work and a testnet window earns no credit; production stays blank (mining.pow_spec_unset). The
    // worker quiet interval and the evaluator's interval too (J-more-catalogue-06 #3, #4, #6), so a quiet worker turns
    // offline within a journey; the automatic alert share stays blank (mining.alert_limit_unset).
    ...published(),
  }),
});
