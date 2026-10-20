import { createHttpCopyLeaderFixturesPort } from './copy-leader-fixtures-http-port.js';
import { SECRET, keyCases } from '../s2s-keys-fixture.js';

keyCases('svc-agents -> svc-trade copy leader fixtures', 'svc-trade', async (fetchImpl, s2s) => {
  await createHttpCopyLeaderFixturesPort({ tradeUrl: 'http://trade.test', internalSecret: SECRET, fetchImpl, s2s }).sample();
});
