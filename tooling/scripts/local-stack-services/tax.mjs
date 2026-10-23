export default ({ c, secrets, dbUrl, urlOf, PORTS }) => ({
  // Profit and loss reads api.query('tax','lotBook'); the lot book is the caller's own fills over ledger reads.
  // TAX_JURISDICTION_MAP_JSON stays blank (owner config): the year pack refuses by name, lotBook is not gated by it.
  // TRADE_URL: svc-trade's public candles price a deposit or reward when it arrived. TAX_DEPOSIT_BASIS is LOCAL TEST
  // `customer` (tooling/profiles/test-owner-values/tax.json): an arrival's cost stays unknown until the customer enters one.
  // DATABASE_URL is this stack's svc_tax role. tax is in SCHEMAS, so db:migrate runs before the process listens.
  // DATABASE_POOL_MAX is the stack's common setting, not a size invented here.
  name: 'tax',
  env: () => ({
    ...c('svc-tax', PORTS.tax),
    LEDGER_URL: urlOf('ledger'),
    TRADE_URL: urlOf('trade'),
    TAX_DEPOSIT_BASIS: 'customer',
    DATABASE_URL: dbUrl('svc_tax', secrets),
  }),
});
