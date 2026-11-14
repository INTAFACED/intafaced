import { profileEnvFor } from '../owner-settings.mjs';

export default ({ c, secrets, dbUrl, urlOf, PORTS, CUSTOMER_ORIGIN }) => ({
  name: 'quant',
  // The strategy library, run records and disclosures live in its own schema; no data lake or venue vault is connected.
  // Bar backtests read this stack's own TEST candles and published fee schedule from trade's public routes.
  // The out-of-sample criteria, the holdout and the share read limit are the TEST profile's labelled values (tooling/profiles/test-owner-values/quant.json).
  env: () => ({
    ...c('svc-quant', PORTS.quant),
    DATABASE_URL: dbUrl('svc_quant', secrets),
    TRADE_URL: urlOf('trade'),
    ...profileEnvFor('quant', 'dev'),
    // TEST: the only site that may frame a shared result is this stack's own customer app. `off` leaves the list blank,
    // so a journey can see the embed snippet refused while the link still opens (J-algo-dev-02 #7).
    QUANT_EMBED_ORIGINS: process.env.LOCAL_STACK_QUANT_EMBED_ORIGINS === 'off' ? '' : CUSTOMER_ORIGIN,
  }),
});
