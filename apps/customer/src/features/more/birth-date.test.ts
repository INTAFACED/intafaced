import { describe, expect, it } from 'vitest';
import { birthDateOptions } from './birth-date';

describe('birthDateOptions', () => {
  it('names months in the page language and never asks for a mm/dd/yyyy string', () => {
    const en = birthDateOptions('en', 'Not given', 2026);
    expect(en.months.map((m) => m.label).slice(0, 4)).toEqual(['Not given', 'January', 'February', 'March']);
    expect(birthDateOptions('fr', 'Non indiqué', 2026).months[3]?.label).toBe('mars');
    expect(en.days).toHaveLength(32);
    expect(en.years[1]).toEqual({ value: '2026', label: '2026' });
    expect(en.years.at(-1)).toEqual({ value: '1906', label: '1906' });
    for (const list of [en.days, en.months, en.years]) expect(list[0]).toEqual({ value: '', label: 'Not given' });
  });
});
