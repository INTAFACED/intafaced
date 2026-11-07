import { describe, expect, it } from 'vitest';
import { registeredCopy } from '../../../shared/i18n';
import './copy';
import { NAMED_MODES, flattenOn, toDeskMarket, tradingMode, type DeskListing } from './market';

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

  it('names a restricted mode, and keeps the form on where the desk can still place or explain', () => {
    expect(modeOf({ state: 'POST_ONLY' })).toEqual({ kind: 'named', mode: 'POST_ONLY', newOrders: true });
    expect(modeOf({ state: 'LIMIT_ONLY' })).toEqual({ kind: 'named', mode: 'LIMIT_ONLY', newOrders: true });
    expect(toDeskMarket(listing({ state: 'LIMIT_ONLY' })).open).toBe(true);
    // Cancel-only: the form stays so the refusal is said in words before Confirm, and no new order is taken.
    expect(modeOf({ state: 'CANCEL_ONLY' })).toEqual({ kind: 'named', mode: 'CANCEL_ONLY', newOrders: false });
    expect(toDeskMarket(listing({ state: 'CANCEL_ONLY' })).open).toBe(true);
    expect(modeOf({ state: 'HALTED' })).toEqual({ kind: 'named', mode: 'HALTED', newOrders: false });
    expect(toDeskMarket(listing({ state: 'HALTED' })).open).toBe(false);
    // A restricted mode on a shut session is still named, with no new orders.
    expect(modeOf({ state: 'LIMIT_ONLY' }, { sessionOpen: false })).toEqual({ kind: 'named', mode: 'LIMIT_ONLY', newOrders: false });
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

describe('flatten', () => {
  it('is offered where the service admits a market close: open and limit-only, never post-only or cancel-only', () => {
    expect(flattenOn({ open: true, state: 'OPEN' })).toBe(true);
    expect(flattenOn({ open: true, state: null })).toBe(true);
    expect(flattenOn({ open: true, state: 'LIMIT_ONLY' })).toBe(true);
    expect(flattenOn({ open: true, state: 'POST_ONLY' })).toBe(false);
    expect(flattenOn({ open: true, state: 'CANCEL_ONLY' })).toBe(false);
    expect(flattenOn({ open: false, state: 'OPEN' })).toBe(false);
  });
});
