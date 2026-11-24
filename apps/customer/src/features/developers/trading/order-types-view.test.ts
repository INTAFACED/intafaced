import { describe, expect, it } from 'vitest';
import { spotOrderTypes, venueSpotOrderTypes } from '@intafaced/contracts/spot-order-types';
import { deskCopy } from '../../../screens/trade/desk/copy';
import { OTHER_ORDER_TYPES } from '../../../screens/trade/desk/venue-desk';
import { venueCopy } from '../../trade';
import { acceptedCells, refusedName } from './order-types-view';
import { tradingApiCopy } from './trading-api-copy';

describe('order-types-view', () => {
  const t = tradingApiCopy.forLocale('en').t;
  const desk = deskCopy.forLocale('en').t;
  const venue = venueCopy.forLocale('en').t;

  it('names venue accepted and refused types exactly as VenueSpotDesk and VenueOrderOptions do', () => {
    const data = venueSpotOrderTypes({ symbol: 'BTC-USDC', orderTypes: ['limit', 'market'], timeInForce: ['GTC', 'IOC', 'ALO'] });
    expect(data.accepted.map((row) => acceptedCells(row, t, desk, data.source).name)).toEqual(['Limit', 'Market']);
    expect(acceptedCells(data.accepted[1]!, t, desk, data.source).note).toBe(t('note_venue_market'));
    expect(data.refused.map((row) => row.id)).toEqual([...OTHER_ORDER_TYPES]);
    expect(data.refused.map((row) => refusedName(row, desk, data.source, venue))).toEqual([
      'Stop limit',
      'Stop',
      'Take profit',
      'Trailing stop',
    ]);
  });

  it('keeps the own-book labels intact when source is book', () => {
    const data = spotOrderTypes();
    expect(data.refused.map((row) => refusedName(row, desk))).toEqual(['Trailing stop']);
    expect(acceptedCells(data.accepted.at(-1)!, t, desk).note).toBe(t('note_market'));
  });
});
