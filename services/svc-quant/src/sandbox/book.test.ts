import { describe, expect, it } from 'vitest';
import { QUANT_VENUE_VAULT_UNSET } from '../errors.js';
import { createPaperBook } from './book.js';

describe('paper book', () => {
  it('computes pnl from fills as decimal strings, never a number', () => {
    const book = createPaperBook({ startingCash: '10000', venueVaultSet: false, feeBps: '0' });
    book.buy('BTC-USD', '0.01');
    expect(typeof book.cash()).toBe('string');
    expect(typeof book.pnl()).toBe('string');
    expect(book.fills()[0]?.price).toBe('50000');
    expect(book.position('BTC-USD')).toBe('0.01');
    // 10000 - 500 + 500 mark = 0 pnl at unchanged mark
    expect(book.pnl()).toBe('0');
  });

  it('refuses venue OMS when the vault pin is unset', () => {
    const book = createPaperBook({ startingCash: '10000', venueVaultSet: false, feeBps: '0' });
    expect(() => book.venueBuy('BTC-USD', '0.01')).toThrow(QUANT_VENUE_VAULT_UNSET);
    expect(book.fills()).toHaveLength(0);
    expect(book.pnl()).toBe('0');
  });

  it('still refuses a real external fill when the pin is set but unwrap is unwired', () => {
    const book = createPaperBook({ startingCash: '10000', venueVaultSet: true, feeBps: '0' });
    expect(() => book.venueBuy('BTC-USD', '0.01')).toThrow(QUANT_VENUE_VAULT_UNSET);
    book.buy('BTC-USD', '0.01');
    expect(book.fills()[0]?.venue).toBe('internal');
  });
});
