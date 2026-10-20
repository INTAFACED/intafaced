import { createOutreachNotificationClient } from './notification-client.js';
import { SECRET, keyCases } from '../s2s-keys-fixture.js';

// The recorder's empty reply carries no receipt, so send resolves null; only the request on the wire is judged.
keyCases('svc-ops -> svc-notify guest ingress', 'svc-notify', async (fetchImpl, s2s) => {
  await createOutreachNotificationClient({
    notifyUrl: 'http://notify.test',
    secret: SECRET,
    fetcher: fetchImpl,
    ...(s2s ? { s2s } : {}),
  }).get('guest:business-key-1');
});
