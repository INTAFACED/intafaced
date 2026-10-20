import { createStakeSource } from './stake-source.js';
import { SECRET, keyCases } from './s2s-keys-fixture.js';

// The empty reply is not a stake, so the read is refused after the request went out; only the request is judged.
keyCases('svc-academy -> svc-token stake read', 'svc-token', async (fetchImpl, s2s) => {
  const real = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    await createStakeSource('http://token.test', SECRET, s2s)
      .stakeOf('u-1')
      .catch(() => undefined);
  } finally {
    globalThis.fetch = real;
  }
});
