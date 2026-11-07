import { describe, expect, it } from 'vitest';
import type { PriceAlert } from '../../notifications/notify-api';
import { alertsOnMarket } from './chart-alerts';

const ME = 'user-1';
const alert = (over: Partial<PriceAlert>): PriceAlert => ({
  id: '00000000-0000-4000-8000-000000000001',
  userId: ME,
  marketId: 'btc-usdt',
  kind: 'price',
  direction: 'above',
  targetPrice: '65000',
  status: 'active',
  firedAt: null,
  createdAt: new Date('2026-11-07T00:00:00Z'),
  ...over,
});
const markets = [
  { id: 'btc-usdt', label: 'BTC/USDT', quote: 'USDT' },
  { id: 'eth-usdt', label: 'ETH/USDT', quote: 'USDT' },
];

describe('alertsOnMarket', () => {
  it("draws the person's open price alerts on the chart's market only", () => {
    const rows = [
      alert({ id: 'a' }),
      alert({ id: 'b', status: 'stopped' }),
      alert({ id: 'c', status: 'fired' }),
      alert({ id: 'd', status: 'cancelled' }),
      alert({ id: 'e', status: 'expired' }),
      alert({ id: 'f', marketId: 'eth-usdt' }),
      alert({ id: 'g', userId: 'someone-else' }),
      alert({ id: 'h', kind: 'funding' }),
    ];
    expect(alertsOnMarket(rows, markets, 'BTC/USDT', ME).map((row) => row.id)).toEqual(['a', 'b']);
  });

  it('draws nothing for a market the listing does not name, or when signed out', () => {
    expect(alertsOnMarket([alert({})], markets, 'SOL/USDT', ME)).toEqual([]);
    expect(alertsOnMarket([alert({})], markets, 'BTC/USDT', null)).toEqual([]);
  });
});
