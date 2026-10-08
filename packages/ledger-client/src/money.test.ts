import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DECIMALS, MoneyError, add, compare, div, formatAmount, mul, mulBps, parseAmount, proRata, sub, sum } from './money.js';

describe('parse / format round trip', () => {
  const cases = ['0', '1', '10.5', '0.000000000000000001', '123456789.123456789123456789', '-42.25'];

  it.each(cases)('round-trips %s', (input) => {
    expect(formatAmount(parseAmount(input))).toBe(input);
  });

  it('normalises trailing zeros', () => {
    expect(formatAmount(parseAmount('10.500'))).toBe('10.5');
    expect(formatAmount(parseAmount('10.000'))).toBe('10');
    expect(formatAmount(parseAmount('-0.0'))).toBe('0');
  });

  it('refuses more precision than the book carries', () => {
    const tooPrecise = `0.${'1'.repeat(DECIMALS + 1)}`;
    expect(() => parseAmount(tooPrecise)).toThrow(MoneyError);
  });

  it('refuses one unit past numeric(38,18) and keeps the largest amount that fits', () => {
    const fits = `${'9'.repeat(20)}.${'9'.repeat(DECIMALS)}`;
    expect(formatAmount(parseAmount(fits))).toBe(fits);
    expect(formatAmount(parseAmount(`-${fits}`))).toBe(`-${fits}`);
    expect(() => parseAmount('100000000000000000000')).toThrow(MoneyError);
    expect(() => parseAmount('-100000000000000000000')).toThrow(MoneyError);
    expect(() => parseAmount(10n ** 38n)).toThrow(MoneyError);
    expect(() => parseAmount(-(10n ** 38n))).toThrow(MoneyError);
  });

  it('refuses anything that is not a decimal string', () => {
    for (const bad of ['', 'abc', '1e18', '1,000', '0x10', '1.2.3', ' 1 2 ']) {
      expect(() => parseAmount(bad), bad).toThrow(MoneyError);
    }
  });

  it('never loses a cent to floating point', () => {
    // 0.1 + 0.2 === 0.30000000000000004 in IEEE-754. Not here.
    expect(formatAmount(add(parseAmount('0.1'), parseAmount('0.2')))).toBe('0.3');
  });
});

describe('arithmetic', () => {
  it('adds and subtracts exactly', () => {
    expect(formatAmount(sub(parseAmount('1'), parseAmount('0.000000000000000001')))).toBe('0.999999999999999999');
  });

  it('multiplies with explicit rounding', () => {
    // 3 × 0.333333333333333333 = 0.999999999999999999
    expect(formatAmount(mul(parseAmount('3'), parseAmount('0.333333333333333333')))).toBe('0.999999999999999999');
  });

  it('rounds a half away from zero', () => {
    const halfAUnit = mul(parseAmount('0.000000000000000001'), parseAmount('0.5'), 'half-up');
    expect(formatAmount(halfAUnit)).toBe('0.000000000000000001');
    expect(formatAmount(mul(parseAmount('0.000000000000000001'), parseAmount('0.5'), 'floor'))).toBe('0');
  });

  it('honours the rounding mode on division', () => {
    expect(formatAmount(div(parseAmount('1'), parseAmount('3'), 'floor'))).toBe('0.333333333333333333');
    expect(formatAmount(div(parseAmount('1'), parseAmount('3'), 'ceil'))).toBe('0.333333333333333334');
  });

  it('floors toward negative infinity and ceils toward positive infinity', () => {
    expect(formatAmount(div(parseAmount('-1'), parseAmount('3'), 'floor'))).toBe('-0.333333333333333334');
    expect(formatAmount(div(parseAmount('-1'), parseAmount('3'), 'ceil'))).toBe('-0.333333333333333333');
  });

  it('refuses division by zero', () => {
    expect(() => div(parseAmount('1'), parseAmount('0'))).toThrow(MoneyError);
  });

  it('compares', () => {
    expect(compare(parseAmount('1'), parseAmount('2'))).toBe(-1);
    expect(compare(parseAmount('2'), parseAmount('2'))).toBe(0);
    expect(compare(parseAmount('3'), parseAmount('2'))).toBe(1);
  });
});

describe('fees (bps)', () => {
  it('applies a basis-point rate', () => {
    // 10 bps of 1000 = 1
    expect(formatAmount(mulBps(parseAmount('1000'), 10))).toBe('1');
  });

  it('rounds fees up by default, so a fee is never silently zero', () => {
    expect(formatAmount(mulBps(parseAmount('0.000000000000000001'), 1))).toBe('0.000000000000000001');
  });

  it('rounds down when explicitly crediting a user', () => {
    expect(formatAmount(mulBps(parseAmount('0.000000000000000001'), 1, 'floor'))).toBe('0');
  });

  it('rejects a negative or fractional bps', () => {
    expect(() => mulBps(parseAmount('100'), -1)).toThrow(MoneyError);
    expect(() => mulBps(parseAmount('100'), 1.5)).toThrow(MoneyError);
  });
});

describe('proRata — distributions must sum back exactly', () => {
  it('splits evenly when weights are equal', () => {
    const shares = proRata(parseAmount('100'), [parseAmount('1'), parseAmount('1'), parseAmount('1'), parseAmount('1')]);
    expect(shares.map(formatAmount)).toEqual(['25', '25', '25', '25']);
  });

  it('never loses or invents a unit on an indivisible split', () => {
    const total = parseAmount('1');
    const shares = proRata(total, [parseAmount('1'), parseAmount('1'), parseAmount('1')]);
    expect(sum(shares)).toBe(total);
  });

  it('weights proportionally', () => {
    const shares = proRata(parseAmount('90'), [parseAmount('1'), parseAmount('2')]);
    expect(shares.map(formatAmount)).toEqual(['30', '60']);
  });

  it('sums back exactly across a thousand uneven stakers', () => {
    const total = parseAmount('12345.678901234567891234');
    const weights = Array.from({ length: 1000 }, (_, i) => parseAmount(String(i + 1)));
    const shares = proRata(total, weights);
    expect(sum(shares)).toBe(total);
    expect(shares.every((s) => s >= 0n)).toBe(true);
  });

  it('refuses a zero total weight', () => {
    expect(() => proRata(parseAmount('10'), [0n, 0n])).toThrow(MoneyError);
  });

  it('refuses a negative weight even when the other weights keep the total positive', () => {
    // 4 + -1 + 1 = 4. Paying the -1 a negative share and lifting the others
    // would still sum to 10, and the ledger would post that misallocation.
    expect(() => proRata(parseAmount('10'), [parseAmount('4'), parseAmount('-1'), parseAmount('1')])).toThrow(MoneyError);
  });

  it('pays a zero weight nothing, including the dust on either sign', () => {
    const weights = [88n, 7n, 0n, 5n, 0n];
    const positive = proRata(3n, weights);
    const negative = proRata(-3n, weights);
    expect(positive).toEqual([3n, 0n, 0n, 0n, 0n]);
    expect(negative).toEqual([-3n, 0n, 0n, 0n, 0n]);
    expect(sum(positive)).toBe(3n);
    expect(sum(negative)).toBe(-3n);
  });
});

describe('no IEEE-754 money', () => {
  function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return walk(path);
      return entry.name.endsWith('.ts') ? [path] : [];
    });
  }

  it('source and tests never coerce amounts through JS Number', () => {
    const root = fileURLToPath(new URL('.', import.meta.url));
    const forbidden = [/parseFloat\s*\(/, /parseInt\s*\(/, /(?<![.\w])Number\s*\(/];
    for (const file of walk(root)) {
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      for (const pattern of forbidden) {
        expect(code, `${file} ${pattern}`).not.toMatch(pattern);
      }
    }
  });
});
