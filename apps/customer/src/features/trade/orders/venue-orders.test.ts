import { describe, expect, it } from 'vitest';
import { historyQuery, readVenueParams } from './VenueOrders';

describe('VenueOrders query params (J-derivatives-04 #1 #2)', () => {
  it('defaults to order history when view is omitted and parses view, origin and label', () => {
    expect(readVenueParams('?product=venue')).toMatchObject({ view: 'history', origin: '', label: '' });
    expect(readVenueParams('?product=venue&view=open')).toMatchObject({ view: 'open' });
    expect(readVenueParams('?product=venue&view=executions')).toMatchObject({ view: 'executions' });
    expect(readVenueParams('?product=venue&view=bogus')).toMatchObject({ view: 'history' });
    expect(readVenueParams('?product=venue&origin=liquidation&label=grid-7')).toMatchObject({
      view: 'history',
      origin: 'liquidation',
      label: 'grid-7',
    });
  });

  it('forwards origin and label in historyQuery', () => {
    const q = historyQuery(readVenueParams('?product=venue&side=sell&status=filled&origin=stop&label=grid-7&size=50'), '0xabc');
    expect(q).toEqual({
      side: 'sell',
      status: 'filled',
      origin: 'stop',
      label: 'grid-7',
      limit: '50',
      before: '0xabc',
    });
  });
});
