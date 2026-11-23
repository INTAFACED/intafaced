/**
 * Home's margin warning level (`BANK_MARGIN_WARNING_LTV_BPS`, J-home-ia-01 #8): blank is read as blank, and a set value
 * refuses boot, since the item it would list comes only with the custodial layer (J-home-ia-01 #7, Later).
 */
import { describe, expect, it } from 'vitest';
import { readMarginWarningLevel } from './work-items.js';

describe('readMarginWarningLevel', () => {
  it('reads unset, empty and spaces as blank', () => {
    expect(readMarginWarningLevel(undefined)).toBeNull();
    expect(readMarginWarningLevel('')).toBeNull();
    expect(readMarginWarningLevel('   ')).toBeNull();
  });

  it('refuses any value, a number included, rather than accepting a level that lists nothing', () => {
    for (const raw of ['7000', '0', 'off'])
      expect(() => readMarginWarningLevel(raw)).toThrow(/BANK_MARGIN_WARNING_LTV_BPS must stay blank/);
  });
});
