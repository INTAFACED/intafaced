import { describe, expect, it } from 'vitest';
import { countryOptions } from './sign-up';

describe('countryOptions', () => {
  it.each(['en', 'de', 'fr', 'ja', 'ar'])('names each country once in %s', (locale) => {
    const names = countryOptions(locale).map((o) => o.name);
    const twice = names.filter((name, i) => names.indexOf(name) !== i);
    expect(twice).toEqual([]);
  });

  it('keeps the current ISO code and drops the retired one', () => {
    const codes = new Set(countryOptions('en').map((o) => o.code));
    for (const current of ['GB', 'RS', 'DE', 'FR', 'RU', 'MM', 'CD', 'CW', 'VN', 'YE', 'ZW', 'VU', 'TL', 'BJ', 'BF']) {
      expect(codes.has(current), current).toBe(true);
    }
    for (const retired of ['UK', 'YU', 'CS', 'DD', 'FX', 'SU', 'BU', 'ZR', 'AN', 'VD', 'YD', 'RH', 'NH', 'TP', 'DY', 'HV']) {
      expect(codes.has(retired), retired).toBe(false);
    }
  });

  it('leaves out codes that name no country', () => {
    const codes = new Set(countryOptions('en').map((o) => o.code));
    for (const code of ['EU', 'UN', 'ZZ']) expect(codes.has(code), code).toBe(false);
  });
});
