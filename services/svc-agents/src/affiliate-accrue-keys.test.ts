import { parseAmount } from '@intafaced/ledger-client';
import { createAffiliateAccrueClient } from './affiliate-accrue.js';
import { SECRET, keyCases } from './s2s-keys-fixture.js';

const leg = { userId: 'u-1', feeAmount: parseAmount('5'), feeAsset: 'USDT', feeEventId: 'fee-1' };

// The accrue client posts with the global fetch, so the recorder stands in for it for the call.
keyCases('svc-agents -> svc-identity affiliate accrue', 'svc-identity', async (fetchImpl, s2s) => {
  const real = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    await createAffiliateAccrueClient('http://identity.test', SECRET, s2s).accrueAgentsFee(leg);
  } finally {
    globalThis.fetch = real;
  }
});
