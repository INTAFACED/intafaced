import { describe, expect, it } from 'vitest';
import { decimalSchema, parseAmount, signedDecimalSchema } from './money';

/** What parseAmount itself says of a string: its value, or null when it refuses. */
const parsed = (value: string): bigint | null => {
  try {
    return parseAmount(value);
  } catch {
    return null;
  }
};

const CASES = [
  '0',
  '-0',
  '1',
  '-1',
  '1.5',
  '-1.5',
  '0001',
  ' 2.25 ',
  '\t3\n',
  '1.',
  '.5',
  '+1',
  '1e5',
  '',
  ' ',
  '-',
  '1.2.3',
  '0.000000000000000001',
  '0.0000000000000000001',
  '-0.000000000000000001',
  '99999999999999999999.999999999999999999',
  '100000000000000000000',
  '-99999999999999999999.999999999999999999',
  '-100000000000000000000',
  '00000000000000000000099999999999999999999',
  '1,000',
  'NaN',
  'Infinity',
  '١٢',
  '12abc',
];

describe('the wire amount schemas are parseAmount', () => {
  it.each(CASES)('%j: unsigned accepts exactly what parseAmount reads as zero or more', (value) => {
    const v = parsed(value);
    expect(decimalSchema.safeParse(value).success).toBe(v !== null && v >= 0n);
  });
  it.each(CASES)('%j: signed accepts exactly what parseAmount reads', (value) => {
    expect(signedDecimalSchema.safeParse(value).success).toBe(parsed(value) !== null);
  });
  it('keeps the string as it came and refuses a number', () => {
    expect(decimalSchema.parse(' 2.25 ')).toBe(' 2.25 ');
    expect(signedDecimalSchema.safeParse(1).success).toBe(false);
  });
});
