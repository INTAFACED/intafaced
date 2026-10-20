import { createAccountStateClient } from './account-state.js';
import { SECRET, keyCases } from './s2s-keys-fixture.js';

// The empty reply is not an account, so the read comes back null after the request went out; only the request is judged.
keyCases('svc-support -> svc-identity account read', 'svc-identity', async (fetchImpl, s2s) => {
  const real = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    await createAccountStateClient('http://identity.test', SECRET, s2s).stateOf('u-1');
  } finally {
    globalThis.fetch = real;
  }
});
