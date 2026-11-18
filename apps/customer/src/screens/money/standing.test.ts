import { describe, expect, it } from 'vitest';
import { shownUsd, standing, type PartInput } from './standing';

const PRICES = {
  published: true as const,
  test: true,
  source: 'TEST price list',
  asOf: '2026-11-14T08:00:00.000Z',
  prices: [
    { asset: 'USDC', usd: '1' },
    { asset: 'USDT', usd: '1' },
  ],
};
const wallet = (rows: PartInput['read']): PartInput => ({ id: 'wallet', label: 'Base Sepolia', read: rows });
const venue: PartInput = {
  id: 'venue',
  label: 'TEST venue',
  test: true,
  read: { state: 'read', asOf: '2026-11-14T08:01:00.000Z', rows: [{ asset: 'USDC', amount: '500.123456789012345678' }] },
};
const partner: PartInput = {
  id: 'partner',
  label: 'TEST partner bank',
  read: { state: 'read', asOf: '2026-11-14T08:02:00.000Z', rows: [{ asset: 'USDT', amount: '50' }] },
};

describe('where a person stands (J-home-ia-01 #1)', () => {
  it('adds what each source reports at its published price, each part named with its as-of time', () => {
    const s = standing(
      [
        wallet({
          state: 'read',
          asOf: '2026-11-14T07:59:00.000Z',
          rows: [
            { asset: 'TESTUSD', amount: '100' },
            { asset: 'ETH', amount: '0.5' },
          ],
        }),
        venue,
        partner,
      ],
      PRICES,
      'USD',
    );
    expect(s.totalUsd).toBe('550.12');
    expect(s.unpriced).toEqual(['TESTUSD', 'ETH']);
    expect(s.unread).toEqual([]);
    expect(s.parts.map((p) => [p.id, p.asOf, p.valueUsd])).toEqual([
      ['wallet', '2026-11-14T07:59:00.000Z', null],
      ['venue', '2026-11-14T08:01:00.000Z', '500.123456789012345678'],
      ['partner', '2026-11-14T08:02:00.000Z', '50'],
    ]);
    expect(s.prices).toEqual({ source: 'TEST price list', asOf: '2026-11-14T08:00:00.000Z', test: true });
  });

  it('names a source that cannot be read and leaves it out, never as zero', () => {
    const s = standing([wallet({ state: 'read', asOf: 'x', rows: [] }), venue, { ...partner, read: { state: 'unread' } }], PRICES, 'USD');
    expect(s.unread).toEqual(['partner']);
    expect(s.totalUsd).toBe('500.12');
    expect(s.parts[2]).toMatchObject({ state: 'unread', valueUsd: null, rows: [] });
  });

  it('has no total with no price published, and names every asset', () => {
    const s = standing([venue, partner], { published: false, code: 'valuation.prices_unset' }, 'USD');
    expect(s.totalUsd).toBeNull();
    expect(s.unpriced).toEqual(['USDC', 'USDT']);
    expect(s.prices).toBeNull();
  });

  it('keeps dollars in the BTC unit when BTC has no published price, and converts when it has', () => {
    expect(standing([venue], PRICES, 'BTC').btc).toEqual({ total: null, reason: 'no_btc_price' });
    const withBtc = { ...PRICES, prices: [...PRICES.prices, { asset: 'BTC', usd: '60000' }] };
    expect(standing([venue], withBtc, 'BTC').btc).toEqual({ total: '0.00833539' });
    expect(standing([], withBtc, 'BTC').btc).toEqual({ total: null, reason: 'nothing_priced' });
  });

  it('rounds half up to cents only when shown', () => {
    expect(shownUsd('0.005')).toBe('0.01');
    expect(shownUsd('0.004999999999999999')).toBe('0.00');
    expect(shownUsd('1234.5')).toBe('1234.50');
  });
});
