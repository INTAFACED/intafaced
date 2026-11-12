import { describe, expect, it } from 'vitest';
import { LEDGER_POST_ALLOWLIST, grantFor, modulesFor } from './caller-allowlist.js';
import { LEDGER_DOOR_CALLERS } from './door-callers.js';

describe('svc-academy ledger grant (J-academy-07)', () => {
  it('may post academyPurchase and academyPurchaseRefund in the academy module, and nothing else', () => {
    expect(LEDGER_POST_ALLOWLIST['svc-academy']).toEqual({
      academyPurchase: { module: 'academy', cite: 'services/svc-academy/src/purchases/purchase-ledger.ts' },
      academyPurchaseRefund: { module: 'academy', cite: 'services/svc-academy/src/purchases/purchase-ledger.ts' },
    });
    expect(grantFor('svc-academy', 'deposit')).toBeUndefined();
    expect(grantFor('svc-academy', 'chargeEarn')).toBeUndefined();
    expect(grantFor('svc-academy', 'feeCharge')).toBeUndefined();
    expect([...modulesFor('svc-academy')]).toEqual(['academy']);
  });

  it('posts and reads back its own keys, and reads no balance or history', () => {
    const has = (door: keyof typeof LEDGER_DOOR_CALLERS) => (LEDGER_DOOR_CALLERS[door] as readonly string[]).includes('svc-academy');
    expect(has('post')).toBe(true);
    expect(has('txByKey')).toBe(true);
    for (const door of ['balance', 'balances', 'txById', 'history', 'historyPage', 'holdingsHistory', 'ownFunds'] as const) {
      expect(has(door), door).toBe(false);
    }
  });
});
