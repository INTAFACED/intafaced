import { describe, expect, it } from 'vitest';
import { LEDGER_POST_ALLOWLIST, grantFor, modulesFor } from './caller-allowlist.js';
import { LEDGER_DOOR_CALLERS } from './door-callers.js';

describe('svc-campaigns ledger grant (J-campaigns-02)', () => {
  it('may post rewardPay and sweepFeesToRewards in the token module and nothing else', () => {
    expect(LEDGER_POST_ALLOWLIST['svc-campaigns']).toEqual({
      rewardPay: { module: 'token', cite: 'services/svc-campaigns/src/payouts.ts' },
      sweepFeesToRewards: { module: 'token', cite: 'services/svc-campaigns/src/payouts.ts' },
    });
    expect(grantFor('svc-campaigns', 'rewardPay')?.module).toBe('token');
    expect(grantFor('svc-campaigns', 'deposit')).toBeUndefined();
    expect(grantFor('svc-campaigns', 'mintEmission')).toBeUndefined();
    expect(grantFor('svc-campaigns', 'feeCharge')).toBeUndefined();
    expect([...modulesFor('svc-campaigns')]).toEqual(['token']);
  });

  it('posts and reads back its own keys, and reads no balance or history', () => {
    const has = (door: keyof typeof LEDGER_DOOR_CALLERS) => (LEDGER_DOOR_CALLERS[door] as readonly string[]).includes('svc-campaigns');
    expect(has('post')).toBe(true);
    expect(has('txByKey')).toBe(true);
    for (const door of ['balance', 'balances', 'txById', 'history', 'historyPage', 'holdingsHistory'] as const) {
      expect(has(door), door).toBe(false);
    }
  });
});
