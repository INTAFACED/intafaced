import { createHttpNavigatorIdentitySessionPort } from './identity-session-http-port.js';
import { SECRET, keyCases } from '../s2s-keys-fixture.js';

keyCases('svc-agents -> svc-identity navigator session read', 'svc-identity', async (fetchImpl, s2s) => {
  const port = createHttpNavigatorIdentitySessionPort({ identityUrl: 'http://identity.test', internalSecret: SECRET, fetchImpl, s2s });
  await port.read('sess 1/a');
});
