import { describe, expect, it } from 'vitest';
import { defaultListing } from './TradeRoutes';

const m = (symbol: string, active: boolean, orderable: boolean) => ({ symbol, active, orderable });

describe('defaultListing', () => {
  it('prefers BTC/USDT when it can take orders', () => {
    expect(defaultListing([m('AUD/USD', true, false), m('ETH/USDT', true, true), m('BTC/USDT', true, true)])?.symbol).toBe('BTC/USDT');
  });
  it('skips an active market that cannot take orders', () => {
    expect(defaultListing([m('AUD/USD', true, false), m('ETH/USDT', true, true)])?.symbol).toBe('ETH/USDT');
  });
  it('falls back to the first active market, then the first market', () => {
    expect(defaultListing([m('X/Y', false, false), m('AUD/USD', true, false)])?.symbol).toBe('AUD/USD');
    expect(defaultListing([m('X/Y', false, false)])?.symbol).toBe('X/Y');
    expect(defaultListing([])).toBeUndefined();
  });
});
