import { describe, expect, it } from 'vitest';
import {
  fiatCurrencyCatalogBoardCard,
  fiatCurrencyCatalogStatusLine,
  parseFiatCurrencyCatalogStatusLine,
  fiatCurrencyCatalogStatusLineMatches,
  fiatCurrencyCatalogStatusLineConsistent,
  fiatCurrencyCatalogExportHeader,
  fiatCurrencyCatalogExportLines,
  fiatCurrencyCatalogExportText,
  isDeclaredFiatCurrency,
  FIAT_CODES,
} from './fiat-currency-honesty.js';
import { FIAT_CURRENCIES, formatFiat } from './fiat.js';

describe('L3 wave217 fiat-currency catalog honesty', () => {
  it('fiat currency catalog boards', () => {
    expect(FIAT_CODES.length).toBe(FIAT_CURRENCIES.length);
    expect(FIAT_CODES.length).toBeGreaterThanOrEqual(100);
    expect(FIAT_CODES).toContain('USD');
    expect(FIAT_CODES).toContain('EUR');
    const card = fiatCurrencyCatalogBoardCard();
    expect(card.hasUsd).toBe(1);
    expect(card.hasEur).toBe(1);
    expect(card.hasJpy).toBe(1);
    expect(card.currencies).toBe(FIAT_CURRENCIES.length);
    expect(card.zeroMinor).toBe(FIAT_CURRENCIES.filter((c) => c.minorUnits === 0).length);
    expect(fiatCurrencyCatalogStatusLineMatches()).toBe(true);
    expect(fiatCurrencyCatalogStatusLineConsistent(fiatCurrencyCatalogStatusLine())).toBe(true);
    expect(fiatCurrencyCatalogExportText().startsWith(fiatCurrencyCatalogExportHeader())).toBe(true);
    expect(fiatCurrencyCatalogExportLines()).toEqual([...FIAT_CODES]);
    expect(isDeclaredFiatCurrency('USD')).toBe(true);
    expect(isDeclaredFiatCurrency('XXX')).toBe(false);
    expect(parseFiatCurrencyCatalogStatusLine('nope')).toBeNull();
  });
});

describe('formatFiat decimal string', () => {
  it('throws on a blank or whitespace amount', () => {
    expect(() => formatFiat('', 'USD')).toThrow(/blank/);
    expect(() => formatFiat('   ', 'USD')).toThrow(/blank/);
    expect(() => formatFiat(' \t', 'XYZ')).toThrow(/blank/);
  });

  it('keeps minor-unit digits a float would not', () => {
    const usd = FIAT_CURRENCIES.find((row) => row.code === 'USD');
    const mga = FIAT_CURRENCIES.find((row) => row.code === 'MGA');
    expect(usd?.minorUnits).toBe(2);
    expect(mga?.minorUnits).toBe(0);
    expect(formatFiat('0.10', 'USD')).toMatch(/^(?:[^\d]*0\.10[^\d]*)$/);
    expect(formatFiat('1.2', 'USD')).toMatch(/^(?:[^\d]*1\.20[^\d]*)$/);
    expect(formatFiat('9007199254740993', 'MGA')).toMatch(/^(?:[^\d]*9007199254740993[^\d]*)$/);
    expect(formatFiat('-0.10', 'USD')).toMatch(/0\.10/);
    expect(formatFiat('-0.10', 'USD')).toContain('-');
  });

  it('throws when the fraction has one more digit than minorUnits', () => {
    expect(() => formatFiat('0.101', 'USD')).toThrow(/minor units/);
    expect(() => formatFiat('1.0', 'MGA')).toThrow(/minor units/);
  });

  it('returns an unknown code beside the decimal string', () => {
    expect(FIAT_CURRENCIES.some((row) => row.code === 'XYZ')).toBe(false);
    expect(formatFiat('42.50', 'XYZ')).toBe('42.50 XYZ');
  });
});
