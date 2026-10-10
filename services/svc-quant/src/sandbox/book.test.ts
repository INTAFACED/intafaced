import { describe, expect, it } from 'vitest';
import { QUANT_VENUE_VAULT_UNSET } from '../errors.js';
import { createPaperBook } from './book.js';

const paramsInvalid = expect.objectContaining({ code: 'quant.params_invalid' });

describe('paper book', () => {
  it('computes pnl from fills as decimal strings, never a number', () => {
    const book = createPaperBook({
      startingCash: '10000',
      venueVaultSet: false,
      marks: { 'BTC-USD': '2' },
    });
    expect(() => book.buy('SOL-USD', '1')).toThrow(paramsInvalid);
    expect(book.fills()).toHaveLength(0);
    book.buy('BTC-USD', '0.01');
    expect(typeof book.cash()).toBe('string');
    expect(typeof book.pnl()).toBe('string');
    expect(book.fills()[0]?.price).toBe('2');
    expect(book.last('BTC-USD')).toBe('2');
    expect(book.bid('BTC-USD')).toBe('2');
    expect(book.ask('BTC-USD')).toBe('2');
    expect(book.position('BTC-USD')).toBe('0.01');
    expect(book.cash()).toBe('9999.98');
    // Cash drops by qty × mark; the same mark adds it back, so pnl is 0.
    expect(book.pnl()).toBe('0');
    expect(book.sell('BTC-USD', '0.01').price).toBe('2');
    expect(book.position('BTC-USD')).toBe('0');
    expect(book.cash()).toBe('10000');
    expect(book.pnl()).toBe('0');
  });

  it('refuses buy, sell, last, bid, and ask when the caller omits a mark', () => {
    const book = createPaperBook({ startingCash: '10000', venueVaultSet: false });
    expect(() => book.buy('BTC-USD', '0.01')).toThrow(paramsInvalid);
    expect(() => book.sell('ETH-USD', '0.5')).toThrow(paramsInvalid);
    expect(() => book.sell('IFC-USD', '1')).toThrow(paramsInvalid);
    expect(() => book.last('BTC-USD')).toThrow(paramsInvalid);
    expect(() => book.bid('ETH-USD')).toThrow(paramsInvalid);
    expect(() => book.ask('IFC-USD')).toThrow(paramsInvalid);
    expect(book.fills()).toHaveLength(0);
    expect(book.cash()).toBe('10000');
    expect(book.position('BTC-USD')).toBe('0');
    expect(book.pnl()).toBe('0');

    const blank = createPaperBook({
      startingCash: '10000',
      venueVaultSet: false,
      marks: { 'BTC-USD': '' },
    });
    expect(() => blank.buy('BTC-USD', '0.01')).toThrow(paramsInvalid);
    expect(() => blank.last('BTC-USD')).toThrow(paramsInvalid);
    expect(blank.pnl()).toBe('0');
    expect(blank.fills()).toHaveLength(0);
  });

  it('refuses venue OMS when the vault pin is unset', () => {
    const book = createPaperBook({ startingCash: '10000', venueVaultSet: false });
    expect(() => book.venueBuy('BTC-USD', '0.01')).toThrow(QUANT_VENUE_VAULT_UNSET);
    expect(() => book.venueSell('BTC-USD', '0.01')).toThrow(QUANT_VENUE_VAULT_UNSET);
    expect(book.fills()).toHaveLength(0);
    expect(book.pnl()).toBe('0');

    const marked = createPaperBook({
      startingCash: '10000',
      venueVaultSet: false,
      marks: { 'BTC-USD': '2' },
    });
    expect(() => marked.venueBuy('BTC-USD', '0.01')).toThrow(QUANT_VENUE_VAULT_UNSET);
    expect(() => marked.venueSell('BTC-USD', '0.01')).toThrow(QUANT_VENUE_VAULT_UNSET);
    expect(marked.fills()).toHaveLength(0);
  });

  it('still refuses a real external fill when the pin is set but unwrap is unwired', () => {
    const book = createPaperBook({
      startingCash: '10000',
      venueVaultSet: true,
      marks: { 'BTC-USD': '2' },
    });
    expect(() => book.venueBuy('BTC-USD', '0.01')).toThrow(QUANT_VENUE_VAULT_UNSET);
    expect(() => book.venueSell('BTC-USD', '0.01')).toThrow(QUANT_VENUE_VAULT_UNSET);
    expect(book.fills()).toHaveLength(0);
    book.buy('BTC-USD', '0.01');
    expect(book.fills()[0]?.venue).toBe('internal');
    expect(book.fills()[0]?.price).toBe('2');
  });
});
