export default ({ c, secrets, dbUrl, urlOf, PORTS }) => ({
  // Share ingest and reads over its own schema. The pool fee and the PPLNS window are the owner's blank settings and
  // stay unset (the service refuses by name), and MINING_PAYOUT_INTERVAL_MS stays unset, so no epoch job pays anything.
  name: 'mining-pool',
  entry: 'server.js', // dist/index.js only re-exports; server.js listens
  env: () => ({
    ...c('svc-mining-pool', PORTS['mining-pool']),
    DATABASE_URL: dbUrl('svc_mining_pool', secrets),
    LEDGER_URL: urlOf('ledger'),
  }),
});
