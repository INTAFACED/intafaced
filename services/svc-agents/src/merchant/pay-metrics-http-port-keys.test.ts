import { createHttpPayMetricsPort } from './pay-metrics-http-port.js';
import { SECRET, keyCases } from '../s2s-keys-fixture.js';

keyCases('svc-agents -> svc-pay merchant watch metrics', 'svc-pay', async (fetchImpl, s2s) => {
  await createHttpPayMetricsPort({ payUrl: 'http://pay.test', internalSecret: SECRET, fetchImpl, s2s }).sample();
});
