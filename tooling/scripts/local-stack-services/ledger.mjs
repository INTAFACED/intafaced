export default ({ c, secrets, dbUrl, urlOf, PORTS }) => ({
  name: 'ledger',
  env: () => ({
    ...c('svc-ledger', PORTS.ledger),
    DATABASE_URL: dbUrl('svc_ledger', secrets),
    LEDGER_POSTING_ENABLED: 'true',
    // Required, no default. LOCAL TEST value chosen for this stack only, not an owner decision.
    RECONCILE_CRON_MINUTES: '60',
    // Asset registry edits consume a founder approval from identity; without it they refuse identity_unwired.
    IDENTITY_URL: urlOf('identity'),
  }),
});
