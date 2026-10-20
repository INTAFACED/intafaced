import { createHttpSupportDeskPort } from './desk-port.js';
import { SECRET, keyCases } from '../s2s-keys-fixture.js';

keyCases('svc-agents -> svc-identity support account read', 'svc-identity', async (fetchImpl, s2s) => {
  const desk = createHttpSupportDeskPort({
    supportUrl: 'http://support.test',
    identityUrl: 'http://identity.test',
    internalSecret: SECRET,
    fetchImpl,
    s2s,
  });
  await desk.readAccount('11111111-1111-4111-8111-111111111111');
});
