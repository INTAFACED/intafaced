import { describe, expect, it } from 'vitest';
import { loadWithdrawalLimits } from './config.js';
import { createWithdrawalLimitReader } from './reader.js';
import { staticLimitSource } from './source.js';

// TEST figures, illustrative only.
const LIMITS = loadWithdrawalLimits({
  PAY_WITHDRAWAL_LIMITS_BY_TIER: JSON.stringify({
    full: { USDT: { perTx: '50', rolling24h: '60' } },
    basic: { USDT: { perTx: '10', rolling24h: '15' }, BTC: { perTx: '0.5', rolling24h: '1' } },
  }),
});
const sql = (() => {
  throw new Error('the published list reads no table here');
}) as never;
const reader = (mode: 'off' | 'required', wired = true) =>
  createWithdrawalLimitReader({ sql, source: staticLimitSource(LIMITS), mode, ...(wired ? { tierOf: async () => 'basic' } : {}) });

describe('the published withdrawal limits (verification ladder)', () => {
  it('lists every set figure by tier then asset, enforced when limits are required', async () => {
    expect(await reader('required').published()).toEqual({
      enforced: true,
      limits: [
        { tier: 'basic', assetId: 'BTC', perTx: '0.5', rolling24h: '1' },
        { tier: 'basic', assetId: 'USDT', perTx: '10', rolling24h: '15' },
        { tier: 'full', assetId: 'USDT', perTx: '50', rolling24h: '60' },
      ],
    });
  });

  it('with limits off the figures still list, marked not enforced', async () => {
    expect(await reader('off').published()).toMatchObject({
      enforced: false,
      limits: [{ tier: 'basic' }, { tier: 'basic' }, { tier: 'full' }],
    });
  });

  it('required with no tier source refuses, as the guard refuses every withdrawal then', async () => {
    await expect(reader('required', false).published()).rejects.toMatchObject({ code: 'pay.guard_withdrawal_tier_unwired' });
  });
});
