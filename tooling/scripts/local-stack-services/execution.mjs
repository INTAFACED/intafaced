import path from 'node:path';

export default ({ c, urlOf, PORTS, P }) => ({
  name: 'execution',
  env: () => ({
    ...c('svc-execution', PORTS.execution),
    TRADE_URL: urlOf('trade'),
    MATCHING_URL: urlOf('matching'),
    EXECUTION_EMS_STORE_PATH: path.join(P.data, 'execution', 'ems-orders.ndjson'),
    // EXECUTION_VENUE_IDS empty: no outside venue, so nothing can route off-platform.
  }),
});
