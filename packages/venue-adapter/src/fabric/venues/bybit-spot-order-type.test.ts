import { describe, expect, it } from 'vitest';
import { VenueUnavailableError } from '@intafaced/venue-contracts';
import { mapBybitSpotOrder } from './bybit-spot-trade.js';

const now = new Date('2026-10-07T00:00:00.000Z');

function openRow(orderType?: string, omitOrderType = false): Record<string, unknown> {
  const row: Record<string, unknown> = {
    orderId: '9',
    orderLinkId: 'abc',
    symbol: 'BTCUSDT',
    side: 'Buy',
    price: '1',
    qty: '1',
    cumExecQty: '0',
    avgPrice: '0',
    orderStatus: 'New',
    createdTime: '1',
  };
  if (!omitOrderType) row.orderType = orderType;
  return row;
}

describe('mapBybitSpotOrder order type', () => {
  it('refuses an omitted, empty, or unknown orderType instead of mapping it to limit', () => {
    const cases: ReadonlyArray<{ label: string; row: Record<string, unknown> }> = [
      { label: 'omitted', row: openRow(undefined, true) },
      { label: 'empty', row: openRow('') },
      { label: 'Stop', row: openRow('Stop') },
    ];
    for (const { label, row } of cases) {
      let accepted: string | undefined;
      let refused = false;
      try {
        accepted = mapBybitSpotOrder(row, 'BTC/USDT', now).type;
      } catch (error) {
        refused = true;
        expect(error).toBeInstanceOf(VenueUnavailableError);
        expect((error as VenueUnavailableError).venueId).toBe('bybit-spot');
        expect((error as VenueUnavailableError).reason).toBe('malformed');
        expect(String((error as Error).message)).toMatch(/order type/);
      }
      if (!refused) expect.unreachable(`${label} orderType was accepted as ${accepted}`);
      expect(accepted).not.toBe('limit');
    }
  });

  it("maps Bybit Limit and Market to limit and market", () => {
    expect(mapBybitSpotOrder(openRow('Limit'), 'BTC/USDT', now).type).toBe('limit');
    expect(mapBybitSpotOrder(openRow('Market'), 'BTC/USDT', now).type).toBe('market');
  });
});
