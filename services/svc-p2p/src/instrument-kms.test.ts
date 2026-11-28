import { describe, expect, it } from 'vitest';
import { loadP2pEnv } from './testing/env-load-fixture.js';
import { P2pError } from './p2p-service.js';
import { P2P_INSTRUMENT_KMS_REQUIRED, refuseLiveOffersUntilOwnerKms } from './instrument-kms.js';

describe('live offers refuse until OWNER KMS', () => {
  it('named-refuses — no key invented', () => {
    expect(() => refuseLiveOffersUntilOwnerKms()).toThrow(P2pError);
    try {
      refuseLiveOffersUntilOwnerKms();
    } catch (err) {
      expect(err).toMatchObject({
        code: P2P_INSTRUMENT_KMS_REQUIRED,
        message: P2P_INSTRUMENT_KMS_REQUIRED,
      });
    }
  });

  it('does not ship an env that pretends KMS is wired', async () => {
    const env = await loadP2pEnv({ P2P_KMS_KEY_ID: 'kms-1', P2P_INSTRUMENT_KMS_URL: 'https://kms.example', LOCAL_TEST_KMS: 'on' });
    expect(Object.keys(env).filter((key) => /KMS/.test(key))).toEqual([]);
  });
});
