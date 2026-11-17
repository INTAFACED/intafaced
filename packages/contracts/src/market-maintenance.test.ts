import { describe, expect, it } from 'vitest';
import { marketComponentId, upcomingMaintenanceFor, type MarketMaintenanceRead } from './market-maintenance.js';

const NOW = new Date('2026-11-06T09:00:00.000Z');
const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

describe('market maintenance (J-cex-spot-14 #5)', () => {
  it('names a spot market by its lower-case component, and nothing else', () => {
    expect(marketComponentId('BTC/USDC')).toBe('market-btc-usdc');
    expect(marketComponentId('BTC')).toBeNull();
    expect(marketComponentId('A/B/C')).toBeNull();
    expect(marketComponentId('BTC-PERP/USD T')).toBeNull();
  });

  it('a board that could not be read is unavailable, never "none"', () => {
    expect(upcomingMaintenanceFor('BTC/USDC', null, NOW)).toEqual({ status: 'unavailable' });
    expect(upcomingMaintenanceFor('BTC/USDC', { windows: [] }, NOW)).toEqual({ status: 'none' });
  });

  it('takes the nearest window not ended for this market: scheduled before its start, in progress from it', () => {
    const read: MarketMaintenanceRead = {
      windows: [
        { id: id(1), title: 'later', markets: ['market-btc-usdc'], startsAt: '2026-11-06T12:00:00.000Z', endsAt: null },
        {
          id: id(2),
          title: 'soon',
          markets: ['market-btc-usdc'],
          startsAt: '2026-11-06T10:00:00.000Z',
          endsAt: '2026-11-06T11:00:00.000Z',
        },
        {
          id: id(3),
          title: 'ended',
          markets: ['market-btc-usdc'],
          startsAt: '2026-11-06T07:00:00.000Z',
          endsAt: '2026-11-06T08:00:00.000Z',
        },
        { id: id(4), title: 'other market', markets: ['market-eth-usdc'], startsAt: '2026-11-06T09:30:00.000Z', endsAt: null },
      ],
    };
    expect(upcomingMaintenanceFor('BTC/USDC', read, NOW)).toEqual({
      status: 'scheduled',
      noticeId: id(2),
      title: 'soon',
      startsAt: '2026-11-06T10:00:00.000Z',
      endsAt: '2026-11-06T11:00:00.000Z',
    });
    expect(upcomingMaintenanceFor('BTC/USDC', read, new Date('2026-11-06T10:00:00.000Z'))).toMatchObject({
      status: 'in_progress',
      noticeId: id(2),
    });
    expect(upcomingMaintenanceFor('SOL/USDC', read, NOW)).toEqual({ status: 'none' });
  });
});
