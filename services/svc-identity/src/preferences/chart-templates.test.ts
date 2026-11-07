import { describe, expect, it } from 'vitest';
import { parseChartTemplates } from './chart-templates.js';

const template = (id: string, name = id) => ({
  id,
  name,
  studies: [{ id: 'sma-1', kind: 'sma', inputs: { period: '20' }, color: 'ma-1', hiddenOn: [] }],
  legendAlways: false,
  style: 'candles',
  scheme: 'standard',
  savedAt: '2026-11-07T09:00:00.000Z',
});
const codeOf = (value: unknown) => {
  try {
    parseChartTemplates(value);
    return null;
  } catch (err) {
    return (err as { code?: string }).code;
  }
};

describe('chart templates: shape', () => {
  it('takes named templates with their studies and style', () => {
    expect(parseChartTemplates({ templates: [template('studies', 'TEST studies')] }).templates[0]?.studies[0]?.kind).toBe('sma');
  });

  it('refuses a name over 40 characters, two templates with one name, and an unknown field', () => {
    expect(codeOf({ templates: [template('a', 'x'.repeat(41))] })).toBe('identity.preferences_value_invalid');
    expect(codeOf({ templates: [template('a', 'Scalp'), template('b', 'scalp')] })).toBe('identity.preferences_value_invalid');
    expect(codeOf({ templates: [], extra: 1 })).toBe('identity.preferences_value_invalid');
  });
});
