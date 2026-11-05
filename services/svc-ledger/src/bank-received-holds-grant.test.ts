import { describe, expect, it } from 'vitest';
import { grantFor, modulesFor } from './caller-allowlist.js';

const CITE = 'services/svc-bank/src/holds/received-holds.ts';

describe('svc-bank received-holds grant (PP-money-balance-05, J-pay-03 #5)', () => {
  it('may post the three holds on received funds in the bank module, and no other service may', () => {
    for (const name of ['payReceivedHold', 'payReceivedRelease', 'payReceivedReturn'] as const) {
      expect(grantFor('svc-bank', name)).toEqual({ module: 'bank', cite: CITE });
      expect(grantFor('svc-pay', name)).toBeUndefined();
      expect(grantFor('svc-identity', name)).toBeUndefined();
      expect(grantFor('svc-ops', name)).toBeUndefined();
    }
    expect([...modulesFor('svc-bank')]).toContain('bank');
  });
});
