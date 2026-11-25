import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/money-math';
import { standing, type PartInput } from './standing';
import { allocateStanding, classOf } from './where-allocation';
import type { VenueRow } from './where-it-sits';

const PRICES = {
  published: true as const,
  test: true,
  source: 'TEST price list',
  asOf: '2026-11-24T12:00:00.000Z',
  prices: [
    { asset: 'USDC', usd: '1' },
    { asset: 'USDT', usd: '1' },
    { asset: 'XAU', usd: '2500' },
    { asset: 'EXOTIC', usd: '10' },
  ],
};

const sumUsd = (rows: ReadonlyArray<{ valueUsd: string }>) => rows.reduce((t, r) => t + parseAmount(r.valueUsd), 0n);

describe('allocateStanding (J-portfolio-06 #1)', () => {
  it('groups by coin, class and type with USDT as stablecoin, venue stake and vault under earn, and exact sums to the total', () => {
    const venueRows: VenueRow[] = [
      {
        asset: 'USDT',
        free: '350',
        locked: '50',
        total: '400',
        withdrawable: '350',
        orders: [],
        split: { inOrders: '0', collateral: '0', stake: '50' },
      },
      {
        asset: 'USDC',
        free: '420',
        locked: '80',
        total: '500',
        withdrawable: '420',
        orders: [{ id: 'order:1', symbol: 'BTC-USDC', side: 'buy', locked: '80' }],
        split: { inOrders: '80', collateral: '0', stake: '0' },
      },
      {
        asset: 'BTC',
        free: '0.002',
        locked: '0',
        total: '0.002',
        withdrawable: '0.002',
        orders: [],
        split: { inOrders: '0', collateral: '0', stake: '0' },
      },
    ];
    const parts: PartInput[] = [
      {
        id: 'venue',
        label: 'TEST venue',
        test: true,
        read: {
          state: 'read',
          asOf: '2026-11-24T12:00:00.000Z',
          rows: [
            { asset: 'USDT', amount: '400' },
            { asset: 'USDC', amount: '500' },
            { asset: 'BTC', amount: '0.002' },
            { asset: 'USDC', amount: '100', key: 'vault:0x01' },
          ],
        },
      },
    ];
    const s = standing(parts, PRICES, 'USD');
    const kinds = new Map<string, string>([
      ['USDT', 'crypto'],
      ['USDC', 'crypto'],
      ['BTC', 'crypto'],
    ]);
    const alloc = allocateStanding(s, venueRows, kinds);

    // Total priced: 400 USDT + 500 USDC + 100 vault USDC = 1000 USD; BTC is unpriced and excluded.
    expect(alloc.totalValueUsd).toBe('1000');
    expect(alloc.unpriced).toEqual(['BTC']);
    expect(alloc.classesRefused).toBeNull();

    // Every grouping sums to the exact total.
    expect(sumUsd(alloc.coins)).toBe(parseAmount(alloc.totalValueUsd));
    expect(sumUsd(alloc.classes)).toBe(parseAmount(alloc.totalValueUsd));
    expect(sumUsd(alloc.types)).toBe(parseAmount(alloc.totalValueUsd));
    for (const row of alloc.classes) expect(sumUsd(row.assets)).toBe(parseAmount(row.valueUsd));

    // Coins: USDC = 600 (60%), USDT = 400 (40%).
    expect(alloc.coins).toEqual([
      { asset: 'USDC', valueUsd: '600', share: '0.6' },
      { asset: 'USDT', valueUsd: '400', share: '0.4' },
    ]);

    // Classes: stablecoin = 500 USDC + 350 USDT = 850; earn = 100 vault USDC + 50 staked USDT = 150.
    const byClass = Object.fromEntries(alloc.classes.map((c) => [c.class, c]));
    expect(byClass.stablecoin).toEqual({
      class: 'stablecoin',
      valueUsd: '850',
      share: '0.85',
      assets: [
        { asset: 'USDC', valueUsd: '500', share: '0.5' },
        { asset: 'USDT', valueUsd: '350', share: '0.35' },
      ],
    });
    expect(byClass.earn).toEqual({
      class: 'earn',
      valueUsd: '150',
      share: '0.15',
      assets: [
        { asset: 'USDC', valueUsd: '100', share: '0.1' },
        { asset: 'USDT', valueUsd: '50', share: '0.05' },
      ],
    });

    // Types: available = 350 USDT + 420 USDC = 770; locked = 50 staked USDT + 80 in-orders USDC + 100 vault USDC = 230.
    expect(alloc.types).toEqual([
      { type: 'available', valueUsd: '770', share: '0.77' },
      { type: 'locked', valueUsd: '230', share: '0.23' },
    ]);
  });

  it('places an unlisted asset in unclassified while still adding it to the total, and refuses classes when the registry is unavailable', () => {
    const parts: PartInput[] = [
      {
        id: 'venue',
        label: 'TEST venue',
        read: {
          state: 'read',
          asOf: '2026-11-24T12:00:00.000Z',
          rows: [
            { asset: 'XAU', amount: '1' },
            { asset: 'EXOTIC', amount: '5' },
          ],
        },
      },
    ];
    const s = standing(parts, PRICES, 'USD');
    const kinds = new Map<string, string>([['XAU', 'commodity']]);
    const alloc = allocateStanding(s, [], kinds);
    expect(alloc.totalValueUsd).toBe('2550');
    expect(sumUsd(alloc.classes)).toBe(parseAmount('2550'));
    expect(alloc.classes.map((c) => [c.class, c.valueUsd])).toEqual([
      ['commodity', '2500'],
      ['unclassified', '50'],
    ]);

    const refused = allocateStanding(s, [], null);
    expect(refused.classesRefused).toBe('bank.asset_registry_unavailable');
    expect(refused.classes).toEqual([]);
    expect(refused.types.map((t) => [t.type, t.valueUsd])).toEqual([
      ['available', '2550'],
      ['locked', '0'],
    ]);
  });

  it('classifies stablecoins and USD by code regardless of registry kind', () => {
    const empty = new Map<string, string>();
    expect(classOf('USDT', empty)).toBe('stablecoin');
    expect(classOf('USDC', empty)).toBe('stablecoin');
    expect(classOf('USD', empty)).toBe('fiat');
    expect(classOf('BTC', empty)).toBe('unclassified');
  });
});
