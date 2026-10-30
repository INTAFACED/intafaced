// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Instant-access savings on the Spaces page (BK-pots-03, J-bank-07 #5): the rate from the bank, a blank rate said in
 * words, and each paid day of interest with the total the bank gives, never one the page adds up.
 */

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
const POOL = '11111111-1111-4111-8111-111111111111';
const OTHER_POOL = '22222222-2222-4222-8222-222222222222';
let reads: Record<string, { status: 'ready'; data: unknown } | { status: 'failed'; failure: unknown }>;
vi.mock('./components', async (original) => {
  const real = await original<typeof import('./components')>();
  return {
    ...real,
    useBankRead: (procedure: string) => ({ resource: reads[procedure] ?? { status: 'loading' }, reload: () => undefined }),
  };
});
vi.mock('../session/session', () => ({
  useSession: () => ({ api: { query: async () => ({ ok: false, reason: 'error', message: 'unused' }) } }),
}));
import { InstantSavings } from './InstantSavings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | null = null;

const pool = (id: string, kind: 'flexible' | 'fixed') => ({
  id,
  assetId: 'USDT',
  kind,
  name: `${kind} TEST`,
  aprBps: 400,
  termDays: kind === 'fixed' ? 30 : null,
  minDeposit: '0',
  unbondingDays: null,
});

beforeEach(() => {
  reads = {
    'earn.pools': { status: 'ready', data: [pool(POOL, 'flexible'), pool(OTHER_POOL, 'fixed')] },
    'earn.positions': {
      status: 'ready',
      data: [{ id: '33333333-3333-4333-8333-333333333333', poolId: POOL, assetId: 'USDT', principal: '1000', maturesAt: null }],
    },
    'earn.interestHistory': {
      status: 'ready',
      data: {
        days: [
          { date: '2026-03-04', rateBps: 400, amount: '0.10958904', ledgerTxId: 'tx-3' },
          { date: '2026-03-03', rateBps: 400, amount: '0.10958904', ledgerTxId: 'tx-2' },
        ],
        total: '0.32876712',
        unitemisedDays: 0,
      },
    },
  };
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  document.body.innerHTML = '';
});

async function mount() {
  root = createRoot(host);
  const mounted = root;
  await act(async () => mounted.render(<InstantSavings open={() => undefined} />));
}

describe('InstantSavings', () => {
  it('shows only instant-access pools with the bank’s rate, and the person’s savings with each paid day and the bank’s total', async () => {
    await mount();
    const pools = [...host.querySelectorAll('[data-testid="instant-savings-pool"]')];
    expect(pools.map((el) => el.getAttribute('data-pool'))).toEqual([POOL]);
    expect(host.querySelector('[data-testid="instant-savings-rate"]')!.textContent).toBe('4% a year');
    expect(host.querySelector('[data-testid="instant-savings-position"]')!.textContent).toContain('1,000 USDT');
    const days = [...host.querySelectorAll('[data-testid="instant-savings-day"]')].map((el) => el.textContent);
    expect(days).toEqual(['4 Mar 2026: 0.10958904 USDT at 4%', '3 Mar 2026: 0.10958904 USDT at 4%']);
    // The total is the bank's sum of every paid day, which can be more than this page shows.
    expect(host.querySelector('[data-testid="instant-savings-earned"]')!.textContent).toBe('0.32876712 USDT');
  });

  it('says a blank rate in words and offers nothing to open', async () => {
    reads['earn.pools'] = {
      status: 'failed',
      failure: { ok: false, reason: 'refused', code: 'bank.earn_rate_unset', message: 'Earn rate is unset' },
    };
    await mount();
    const rate = host.querySelector('[data-testid="instant-savings-rate"]')!;
    expect(rate.getAttribute('data-state')).toBe('unset');
    expect(rate.textContent).toBe('No instant-access rate is set. The bank has not published one, so savings cannot open here.');
    expect(host.querySelector('[data-testid="instant-savings-pool"]')).toBeNull();
    expect(host.textContent).not.toContain('bank.earn_rate_unset');
  });

  it('says no interest has been paid before the first day', async () => {
    reads['earn.interestHistory'] = { status: 'ready', data: { days: [], total: '0', unitemisedDays: 0 } };
    await mount();
    expect(host.querySelector('[data-testid="instant-savings-day"]')).toBeNull();
    expect(host.textContent).toContain('No interest paid. The first day’s interest comes the day after you open.');
  });

  it('keeps the interest already paid listed after the savings go back to the account', async () => {
    reads['earn.positions'] = { status: 'ready', data: [] };
    await mount();
    expect(host.querySelector('[data-testid="instant-savings-position"]')).toBeNull();
    expect(host.textContent).toContain('Nothing saved here now. Interest already paid stays listed.');
    expect(host.querySelectorAll('[data-testid="instant-savings-day"]')).toHaveLength(2);
    expect(host.querySelector('[data-testid="instant-savings-earned"]')!.getAttribute('data-amount')).toBe('0.32876712');
  });

  it('shows nothing of a pool the person never saved in, and names days that are not itemised', async () => {
    reads['earn.positions'] = { status: 'ready', data: [] };
    reads['earn.interestHistory'] = { status: 'ready', data: { days: [], total: '0', unitemisedDays: 4 } };
    await mount();
    expect(host.querySelector('[data-testid="instant-savings-mine"]')).toBeNull();
    reads['earn.positions'] = {
      status: 'ready',
      data: [{ id: '33333333-3333-4333-8333-333333333333', poolId: POOL, assetId: 'USDT', principal: '1000', maturesAt: null }],
    };
    act(() => root?.unmount());
    await mount();
    expect(host.querySelector('[data-testid="instant-savings-unitemised"]')!.textContent).toContain('4 paid days of this saving');
  });

  it('offers older days once a page is full', async () => {
    const days = Array.from({ length: 31 }, (_, i) => ({
      date: `2026-03-${String(31 - i).padStart(2, '0')}`,
      rateBps: 400,
      amount: '0.1',
      ledgerTxId: `tx-${i}`,
    }));
    reads['earn.interestHistory'] = { status: 'ready', data: { days, total: '3.1', unitemisedDays: 0 } };
    await mount();
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Show earlier days');
    expect(button).toBeTruthy();
  });
});
