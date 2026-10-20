import { createHostRightsSource } from './host-rights.js';
import { SECRET, keyCases } from './s2s-keys-fixture.js';

// The client reads with the global fetch, so the recorder stands in for it. The empty reply is not a perk table,
// so the call itself is refused after the request went out; only the request is judged here.
keyCases('svc-academy -> svc-identity host rights', 'svc-identity', async (fetchImpl, s2s) => {
  const real = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    await createHostRightsSource('http://identity.test', SECRET, s2s)
      .perksOf('u-1')
      .catch(() => undefined);
  } finally {
    globalThis.fetch = real;
  }
});
