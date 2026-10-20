import { describe, expect, it } from 'vitest';
import { parseAccountDisplay, parseDisplayCurrencyList } from './account-display.js';

describe('account display value', () => {
  it('stores the canonical language code and a listed currency', () => {
    expect(parseAccountDisplay({ locale: 'EN', displayCurrency: 'EUR' }, ['EUR'])).toEqual({ locale: 'en', displayCurrency: 'EUR' });
    expect(parseAccountDisplay({ locale: null, displayCurrency: null }, [])).toEqual({ locale: null, displayCurrency: null });
  });

  it('refuses a language the catalogue does not ship, an unlisted currency, and extra keys', () => {
    expect(() => parseAccountDisplay({ locale: 'tlh', displayCurrency: null }, [])).toThrow('identity.preferences_value_invalid');
    expect(() => parseAccountDisplay({ locale: 'en', displayCurrency: 'USD' }, [])).toThrow('identity.preferences_value_invalid');
    expect(() => parseAccountDisplay({ locale: 'en', displayCurrency: null, x: 1 }, [])).toThrow('identity.preferences_value_invalid');
    expect(() => parseAccountDisplay('en', [])).toThrow('identity.preferences_value_invalid');
  });
});

describe('owner display currency list', () => {
  it('reads blank as nothing listed, never as a default', () => {
    expect(parseDisplayCurrencyList(undefined)).toEqual([]);
    expect(parseDisplayCurrencyList('  ')).toEqual([]);
  });

  it('reads a comma list, drops repeats, and refuses malformed codes', () => {
    expect(parseDisplayCurrencyList('usd, EUR,usd')).toEqual(['USD', 'EUR']);
    expect(() => parseDisplayCurrencyList('USD,€')).toThrow();
  });
});
