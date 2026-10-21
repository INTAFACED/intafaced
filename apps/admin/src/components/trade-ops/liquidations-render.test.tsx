import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { LiquidationDesk } from '@/lib/trade-ops/desk-parse';
import { ok, refused } from '@/lib/trade-ops/outcome';
import { LiquidationsView } from './liquidations-view';

const desk: LiquidationDesk = {
  rungs: [],
  parked: ['p-parked'],
  nearThreshold: [
    {
      positionId: 'p-parked',
      userId: 'u',
      marketId: 'm1',
      side: 'long',
      size: '2',
      markPrice: null,
      liqPrice: '90',
      distanceBps: null,
      reason: 'mark_not_accepted',
    },
    {
      positionId: 'p-2',
      userId: 'u',
      marketId: 'm1',
      side: 'short',
      size: '1',
      markPrice: '100',
      liqPrice: '110',
      distanceBps: 1000,
      reason: null,
    },
  ],
  adlPairs: [],
  owedPayouts: [],
};
const html = (insurance: Parameters<typeof LiquidationsView>[0]['insurance']) =>
  renderToStaticMarkup(<LiquidationsView desk={desk} insurance={insurance} symbols={{ m1: 'BTC-PERP' }} />);

describe('Liquidations room', () => {
  it('draws every section with an honest empty state, and marks the parked position', () => {
    const out = html([]);
    for (const title of ['Insurance fund', 'Liquidation steps', 'Closest to liquidation', 'Auto-deleveraging pairs', 'Owed to winners'])
      expect(out).toContain(title);
    expect(out).toContain('No liquidation steps recorded');
    expect(out).toContain('1 parked');
    expect(out).toContain('BTC-PERP');
    expect(out).toContain('mark_not_accepted');
  });

  it('shows an unreadable insurance balance as a dash with its reason, never zero', () => {
    const out = html([
      {
        asset: 'USDT',
        history: ok({
          asset: 'USDT',
          balance: { value: null, reason: 'ledger_unavailable' },
          draws: [],
          topUps: { reason: 'insurance_topups_not_booked_here' },
        }),
      },
    ]);
    expect(out).toContain('ledger_unavailable');
    expect(out).toContain('insurance_topups_not_booked_here');
    expect(out).toContain('No insurance draws booked');
  });

  it('shows a refused insurance read in the service words', () => {
    const out = html([{ asset: 'USDT', history: refused('trade_ops_admin_unconfigured', 'not wired', 503) }]);
    expect(out).toContain('Insurance fund USDT not read');
    expect(out).toContain('trade_ops_admin_unconfigured');
  });
});
