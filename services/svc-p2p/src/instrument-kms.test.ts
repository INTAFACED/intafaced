import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { P2pError } from './p2p-service.js';
import { P2P_INSTRUMENT_KMS_REQUIRED, refuseLiveOffersUntilOwnerKms } from './instrument-kms.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

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

  it('does not ship an env that pretends KMS is wired', () => {
    const envTs = readFileSync(join(ROOT, 'services/svc-p2p/src/env.ts'), 'utf8');
    expect(envTs).not.toMatch(/P2P_KMS/);
    expect(envTs).not.toMatch(/INSTRUMENT_KMS/);
    expect(envTs).not.toMatch(/LOCAL_TEST_KMS/);
  });
});
