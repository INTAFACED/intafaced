import { createIdentityKycTierClient } from './identity-tier.js';
import { SECRET, keyCases } from '../s2s-keys-fixture.js';

// The empty reply is not an account, so the read is refused after the request went out; only the request is judged.
keyCases('svc-pay -> svc-identity KYC tier read', 'svc-identity', async (fetchImpl, s2s) => {
  await createIdentityKycTierClient({ baseUrl: 'http://identity.test', internalSecret: SECRET, fetchImpl, s2s })('u-1').catch(
    () => undefined,
  );
});
