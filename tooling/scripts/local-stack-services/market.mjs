export default ({ c, secrets, dbUrl, urlOf, PORTS }) => ({
  name: 'market',
  env: () => ({
    ...c('svc-market', PORTS.market),
    DATABASE_URL: dbUrl('svc_market', secrets),
    TOKEN_URL: urlOf('token'),
    LEDGER_URL: urlOf('ledger'),
    IDENTITY_URL: urlOf('identity'),
    // LOCAL TEST only, the labelled value in tooling/profiles/test-owner-values/market.json: the house commission on a
    // Market sale. Production stays blank and every listing and purchase refuses (market.commission_not_configured).
    MARKET_HOUSE_COMMISSION_BPS: '100',
  }),
});
