import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { accessStatus } from './access-status.js';
import { createLocalTestInstrumentKeyProvider } from './instrument-key-provider.js';

describe('p2p access status (P-order-03-be)', () => {
  it('prod key unset -> owner_decision_pending', () => {
    for (const kind of ['none', undefined, null] as const) {
      expect(accessStatus(kind)).toEqual({
        productionInstrumentKey: 'owner_decision_pending',
        localTestKms: false,
        reason: 'p2p.owner_decision_pending',
      });
    }
  });

  it('local test KMS on -> localTestKms true, production key still pending', () => {
    const s = accessStatus('local-test');
    expect(s.localTestKms).toBe(true);
    expect(s.productionInstrumentKey).toBe('owner_decision_pending');
  });

  it('never carries key material or the key label', () => {
    const provider = createLocalTestInstrumentKeyProvider(randomBytes(32), 'TEST-a1b2c3d4');
    const out = JSON.stringify(accessStatus(provider.kind));
    expect(out).not.toContain(provider.keyLabel);
    expect(Object.keys(accessStatus(provider.kind)).sort()).toEqual(['localTestKms', 'productionInstrumentKey', 'reason']);
  });
});
