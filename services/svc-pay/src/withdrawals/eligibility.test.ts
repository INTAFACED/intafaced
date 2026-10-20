import { describe, expect, it } from 'vitest';
import { MemoryLedger, parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { ELIGIBILITY_REASONS, createWithdrawalEligibility, ledgerNegativeBalanceSource, type EligibilitySources } from './eligibility.js';

const USER = '11111111-1111-4111-8111-111111111111';
const clear = async () => ({ state: 'clear' as const });

describe('withdrawal eligibility', () => {
  it('reads every reason as unwired, and not eligible, when nothing is connected', async () => {
    const view = await createWithdrawalEligibility({}).read(USER, 'USDT');
    expect(view.eligible).toBe(false);
    expect(view.checks.map((c) => c.reason)).toEqual([...ELIGIBILITY_REASONS]);
    expect(view.checks.every((c) => c.state === 'unwired' && c.detail)).toBe(true);
  });

  it('is eligible only when every reason is clear', async () => {
    const all: EligibilitySources = Object.fromEntries(ELIGIBILITY_REASONS.map((r) => [r, clear]));
    expect((await createWithdrawalEligibility(all).read(USER, 'USDT')).eligible).toBe(true);
    const oneBlocked = { ...all, open_orders: async () => ({ state: 'blocked' as const, detail: '2 open orders' }) };
    const view = await createWithdrawalEligibility(oneBlocked).read(USER, 'USDT');
    expect(view.eligible).toBe(false);
    expect(view.checks.find((c) => c.reason === 'open_orders')).toEqual({
      reason: 'open_orders',
      state: 'blocked',
      detail: '2 open orders',
    });
  });

  it('treats a source that throws as not checked, never as clear', async () => {
    const view = await createWithdrawalEligibility({
      frozen_credit: async () => {
        throw new Error('identity down');
      },
    }).read(USER, 'USDT');
    expect(view.checks.find((c) => c.reason === 'frozen_credit')).toMatchObject({ state: 'unwired' });
    expect(view.eligible).toBe(false);
  });

  it('passes the caller and the asset to each source', async () => {
    const seen: Array<[string, string]> = [];
    await createWithdrawalEligibility({
      margin_in_use: async (userId, assetId) => {
        seen.push([userId, assetId]);
        return { state: 'clear' };
      },
    }).read(USER, 'BTC');
    expect(seen).toEqual([[USER, 'BTC']]);
  });

  it('blocks on a negative available balance read from the ledger, and clears a zero or positive one', async () => {
    const ledger = new MemoryLedger();
    const source = ledgerNegativeBalanceSource(ledger);
    expect(await source(USER, 'USDT')).toEqual({ state: 'clear' });
    await ledger.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('5'), rail: 'card-sandbox', railRef: 'd1' }));
    expect(await source(USER, 'USDT')).toEqual({ state: 'clear' });
    const negative = ledgerNegativeBalanceSource({ balance: async () => ({ amount: -1n }) } as never);
    expect(await negative(USER, 'USDT')).toEqual({ state: 'blocked' });
  });
});
