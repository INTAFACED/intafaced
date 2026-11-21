import { describe, expect, it } from 'vitest';
import { LEDGER_POST_ALLOWLIST, grantFor, modulesFor } from './caller-allowlist.js';
import { LEDGER_DOOR_CALLERS } from './door-callers.js';

describe('svc-mining-pool ledger grant', () => {
  it('may post rewardPay in the token module and nothing else', () => {
    expect(LEDGER_POST_ALLOWLIST['svc-mining-pool']).toEqual({
      rewardPay: { module: 'token', cite: 'services/svc-mining-pool/src/ledger.ts' },
    });
    expect(grantFor('svc-mining-pool', 'rewardPay')?.module).toBe('token');
    expect(grantFor('svc-mining-pool', 'mintEmission')).toBeUndefined();
    expect(grantFor('svc-mining-pool', 'burn')).toBeUndefined();
    expect(grantFor('svc-mining-pool', 'sweepFeesToRewards')).toBeUndefined();
    expect([...modulesFor('svc-mining-pool')]).toEqual(['token']);
  });

  it('is a poster and a reader, and read-only services stay read-only', () => {
    const post: readonly string[] = LEDGER_DOOR_CALLERS.post;
    const balance: readonly string[] = LEDGER_DOOR_CALLERS.balance;
    expect(post).toContain('svc-mining-pool');
    expect(balance).toContain('svc-mining-pool');
    expect(post).not.toContain('svc-matching');
    expect(post).not.toContain('svc-tax');
  });
});
