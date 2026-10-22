import { describe, expect, it } from 'vitest';
import { registeredCopy } from '../../../shared/i18n';
import './copy';
import { NAMED_MODES, toDeskMarket, tradingMode, type DeskListing } from './market';

const listing = (lifecycle: DeskListing['lifecycle']) =>
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
  }) as unknown as DeskListing;

describe('trading mode', () => {
  it('names the states the desk has words for', () => {
    expect(tradingMode('OPEN')).toBe('OPEN');
    expect(tradingMode('POST_ONLY')).toBe('POST_ONLY');
    expect(tradingMode('HALTED')).toBe('HALTED');
  });

  it('any other listed state is "other", never shown raw and never open', () => {
    expect(tradingMode('DELISTING')).toBe('other');
    expect(toDeskMarket(listing({ state: 'DELISTING' })).open).toBe(false);
  });

  it('a listing with no state, or a blank one, says the state is not listed', () => {
    expect(toDeskMarket(listing(null)).state).toBeNull();
    expect(toDeskMarket(listing({ state: '  ' })).state).toBeNull();
    expect(tradingMode(null)).toBeNull();
  });

  it('every named mode has words', () => {
    const en = registeredCopy().find((entry) => entry.namespace === 'trade.desk')?.messages.en ?? {};
    for (const mode of NAMED_MODES) expect(en[`Mode ${mode}`], mode).toBeTruthy();
  });
});
