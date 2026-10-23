import { profileEnvFor } from '../owner-settings.mjs';

export default ({ c, secrets, dbUrl, urlOf, PORTS }) => ({
  name: 'quant',
  // The strategy library, run records and disclosures live in its own schema; no data lake or venue vault is connected.
  // Bar backtests read this stack's own TEST candles and published fee schedule from trade's public routes.
  // The out-of-sample criteria and the holdout are the TEST profile's labelled values (tooling/profiles/test-owner-values/quant.json).
  env: () => ({
    ...c('svc-quant', PORTS.quant),
    DATABASE_URL: dbUrl('svc_quant', secrets),
    TRADE_URL: urlOf('trade'),
    ...profileEnvFor('quant', 'dev'),
  }),
});
