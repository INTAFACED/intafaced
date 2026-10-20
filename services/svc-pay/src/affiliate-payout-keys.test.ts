import { createAffiliatePayoutClient } from './affiliate-payout.js';
import { SECRET, keyCases } from './s2s-keys-fixture.js';

// The payout client posts with the global fetch, so the recorder stands in for it for the call.
keyCases('svc-pay -> svc-identity affiliate payout', 'svc-identity', async (fetchImpl, s2s) => {
  const real = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    await createAffiliatePayoutClient('http://identity.test', SECRET, s2s).payoutPayFee('fee-1');
  } finally {
    globalThis.fetch = real;
  }
});
