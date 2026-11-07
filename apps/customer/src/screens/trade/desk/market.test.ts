import { describe, expect, it } from 'vitest';
import { registeredCopy } from '../../../shared/i18n';
import './copy';
import { NAMED_MODES, toDeskMarket, tradingMode, type DeskListing } from './market';

const listing = (lifecycle: DeskListing['lifecycle'], over: Partial<DeskListing> = {}) =>
  ({
    symbol: 'BTC/USDT',
    base: 'BTC',
    quote: 'USDT',
    precision: { price: '0.01', amount: '0.00001' },
    limits: { amount: { min: '0.00001' }, cost: { min: '5' } },
    orderable: true,
    active: true,
    sessionOpen: true,
    lifecycle,
    ...over,
  }) as unknown as DeskListing;
const modeOf = (lifecycle: DeskListing['lifecycle'], over?: Partial<DeskListing>) => tradingMode(toDeskMarket(listing(lifecycle, over)));

describe('trading mode', () => {
  it('reads open only when the desk takes orders', () => {
    expect(modeOf({ state: 'OPEN' })).toEqual({ kind: 'open' });
    expect(modeOf({ state: 'OPEN' }, { sessionOpen: false })).toEqual({ kind: 'closed' });
    expect(modeOf({ state: 'OPEN' }, { orderable: false })).toEqual({ kind: 'closed' });
  });

  it('names a state the desk does not trade in, with no new orders', () => {
    expect(modeOf({ state: 'POST_ONLY' })).toEqual({ kind: 'named', mode: 'POST_ONLY' });
    expect(modeOf({ state: 'HALTED' })).toEqual({ kind: 'named', mode: 'HALTED' });
  });

  it('any other listed state is closed, never shown raw', () => {
    expect(modeOf({ state: 'DELISTING' })).toEqual({ kind: 'closed' });
  });

  it('a blank state counts as none listed', () => {
    expect(toDeskMarket(listing(null)).state).toBeNull();
    expect(toDeskMarket(listing({ state: '  ' })).state).toBeNull();
    expect(tradingMode({ open: false, state: null })).toEqual({ kind: 'unlisted' });
  });

  it('every named mode has words', () => {
    const en = registeredCopy().find((entry) => entry.namespace === 'trade.desk')?.messages.en ?? {};
    for (const mode of NAMED_MODES) expect(en[`Mode ${mode}`], mode).toBeTruthy();
  });
});
