export default ({ c, secrets, dbUrl, urlOf, PORTS }) => ({
  name: 'token',
  env: () => ({
    ...c('svc-token', PORTS.token),
    DATABASE_URL: dbUrl('svc_token', secrets),
    LEDGER_URL: urlOf('ledger'),
    IDENTITY_URL: urlOf('identity'),
    TRADE_URL: urlOf('trade'),
    // Nothing mints, distributes or buys back in the background of a test stack.
    EMISSIONS_AUTO_TICK: 'false',
    YIELD_JOB_ENABLED: 'false',
    BUYBACK_JOB_ENABLED: 'false',
  }),
});
