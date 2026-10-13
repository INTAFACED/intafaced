import { describe, expect, it } from 'vitest';
import {
  decimalsOf,
  fromScaled,
  isCompleteAmount,
  isPositiveAmount,
  parsePasted,
  parseTyped,
  roundDecimal,
  stepDecimal,
  toDisplay,
  toScaled,
} from './amount-input-logic.js';

describe('decimal helpers', () => {
  it('counts decimals', () => {
    expect(decimalsOf('12')).toBe(0);
    expect(decimalsOf('12.')).toBe(0);
    expect(decimalsOf('12.340')).toBe(3);
  });

  it('round-trips through bigint without losing digits beyond 2^53', () => {
    const big = '9007199254740993.123456789012345678';
    expect(fromScaled(toScaled(big, 18), 18)).toBe(big);
  });

  it('pads and cuts when scaling', () => {
    expect(toScaled('1.5', 3)).toBe(1500n);
    expect(toScaled('1.23456', 3)).toBe(1234n);
    expect(fromScaled(5n, 3)).toBe('0.005');
    expect(fromScaled(0n, 0)).toBe('0');
  });
});

describe('roundDecimal (rounding)', () => {
  it('truncates toward zero in down mode, never rounding an amount up', () => {
    expect(roundDecimal('0.123456789', 8, 'down')).toBe('0.12345678');
    expect(roundDecimal('1.999', 2, 'down')).toBe('1.99');
    expect(roundDecimal('1.999', 0, 'down')).toBe('1');
  });

  it('rounds half away from zero in half-up mode', () => {
    expect(roundDecimal('1.005', 2, 'half-up')).toBe('1.01');
    expect(roundDecimal('1.004', 2, 'half-up')).toBe('1.00');
    expect(roundDecimal('2.5', 0, 'half-up')).toBe('3');
    expect(roundDecimal('-2.5', 0, 'half-up')).toBe('-3');
  });

  it('is exact where a float would not be', () => {
    // 1.005 * 100 = 100.49999999999999 in IEEE 754; decimal strings stay exact.
    expect(roundDecimal('1.005', 2, 'half-up')).toBe('1.01');
    expect(roundDecimal('0.1000000000000000055511151231257827', 18, 'down')).toBe('0.100000000000000005');
  });

  it('leaves values that already fit untouched', () => {
    expect(roundDecimal('1.50', 4, 'down')).toBe('1.50');
    expect(roundDecimal('7', 2, 'half-up')).toBe('7');
  });
});

describe('parseTyped (typing)', () => {
  const p2 = { precision: 2 };

  it('accepts digits and one dot', () => {
    expect(parseTyped('12.5', p2)).toBe('12.5');
    expect(parseTyped('0', p2)).toBe('0');
    expect(parseTyped('', p2)).toBe('');
  });

  it('keeps an unfinished trailing dot so typing can continue', () => {
    expect(parseTyped('12.', p2)).toBe('12.');
  });

  it('refuses a second dot', () => {
    expect(parseTyped('1.2.', p2)).toBeNull();
    expect(parseTyped('1..2', p2)).toBeNull();
  });

  it('caps decimals at the precision', () => {
    expect(parseTyped('1.23', p2)).toBe('1.23');
    expect(parseTyped('1.234', p2)).toBeNull();
  });

  it('refuses any dot when precision is 0', () => {
    expect(parseTyped('5', { precision: 0 })).toBe('5');
    expect(parseTyped('5.', { precision: 0 })).toBeNull();
  });

  it('prefixes a bare dot with 0 and drops leading zeros', () => {
    expect(parseTyped('.', p2)).toBe('0.');
    expect(parseTyped('.5', p2)).toBe('0.5');
    expect(parseTyped('007', p2)).toBe('7');
    expect(parseTyped('00', p2)).toBe('0');
    expect(parseTyped('0.05', p2)).toBe('0.05');
  });

  it('drops letters, symbols, spaces and minus signs', () => {
    expect(parseTyped('1a2', p2)).toBe('12');
    expect(parseTyped('-5', p2)).toBe('5');
    expect(parseTyped('$ 5', p2)).toBe('5');
  });

  it('reads the other decimal mark as the decimal point when the own mark is absent, never as noise', () => {
    expect(parseTyped('0,5', p2)).toBe('0.5');
    expect(parseTyped('1,', p2)).toBe('1.');
    expect(parseTyped(',5', p2)).toBe('0.5');
    expect(parseTyped('0,50', p2)).toBe('0.50');
    expect(parseTyped('1,2,3', p2)).toBeNull();
    expect(parseTyped('1.2,3', p2)).toBeNull();
    expect(parseTyped('1,2.3', p2)).toBeNull();
    expect(parseTyped('1,234', p2)).toBeNull(); // too many decimals, refused, not read as 1234
  });

  it('uses the locale decimal mark', () => {
    const de = { precision: 2, decimalSeparator: ',' as const };
    expect(parseTyped('1,5', de)).toBe('1.5');
    expect(parseTyped('1,5,', de)).toBeNull();
    expect(parseTyped('1.5', de)).toBe('1.5');
    expect(parseTyped('1,5.', de)).toBeNull();
    expect(toDisplay('1.5', ',')).toBe('1,5');
    expect(toDisplay('1.5', '.')).toBe('1.5');
  });
});

describe('parsePasted (paste and locale separators)', () => {
  const en = { precision: 8 };
  const de = { precision: 8, decimalSeparator: ',' as const };

  it('reads plain numbers', () => {
    expect(parsePasted('1234.5', en)).toBe('1234.5');
    expect(parsePasted('  42  ', en)).toBe('42');
    expect(parsePasted('.5', en)).toBe('0.5');
    expect(parsePasted('0.5', en)).toBe('0.5');
  });

  it('strips US group separators', () => {
    expect(parsePasted('1,234.56', en)).toBe('1234.56');
    expect(parsePasted('1,234,567.89', en)).toBe('1234567.89');
    expect(parsePasted('1,234,567', en)).toBe('1234567');
  });

  it('strips European group separators', () => {
    expect(parsePasted('1.234,56', de)).toBe('1234.56');
    expect(parsePasted('1.234.567,89', en)).toBe('1234567.89');
    expect(parsePasted('1.234.567', en)).toBe('1234567');
  });

  it('strips spaces, non-breaking spaces and apostrophes used as group marks', () => {
    expect(parsePasted('1 234,56', de)).toBe('1234.56');
    expect(parsePasted('1 234,56', de)).toBe('1234.56');
    expect(parsePasted("1'234.56", en)).toBe('1234.56');
  });

  it('strips currency symbols and units', () => {
    expect(parsePasted('$1,234.56', en)).toBe('1234.56');
    expect(parsePasted('0.0042 BTC', en)).toBe('0.0042');
    expect(parsePasted('USDT 15', en)).toBe('15');
  });

  it('drops a minus sign: amounts are never negative', () => {
    expect(parsePasted('-5', en)).toBe('5');
  });

  it('never reads a decimal as a group mark (0,5 is 0.5, not 5)', () => {
    expect(parsePasted('0,5', en)).toBe('0.5');
    expect(parsePasted('12,5', en)).toBe('12.5');
    expect(parsePasted('0,123', en)).toBe('0.123');
    expect(parsePasted('1,23', en)).toBe('1.23');
  });

  it('reads one mark with three digits after it by the person locale', () => {
    expect(parsePasted('1,234', en)).toBe('1234'); // "," is not the US decimal mark
    expect(parsePasted('1.234', en)).toBe('1.234'); // "." is the US decimal mark
    expect(parsePasted('1,234', de)).toBe('1.234'); // "," is the German decimal mark
    expect(parsePasted('1.234', de)).toBe('1234'); // "." is not the German decimal mark
  });

  it('cuts decimals beyond the precision toward zero, never rounding up', () => {
    expect(parsePasted('0.123456789', { precision: 8 })).toBe('0.12345678');
    expect(parsePasted('1.999', { precision: 2 })).toBe('1.99');
    expect(parsePasted('1.9', { precision: 0 })).toBe('1');
  });

  it('refuses text that is not an amount', () => {
    expect(parsePasted('abc', en)).toBeNull();
    expect(parsePasted('', en)).toBeNull();
    expect(parsePasted('1,23.45', en)).toBeNull();
    expect(parsePasted('1,234,567.89.0', en)).toBeNull();
    expect(parsePasted('1,2,3', en)).toBeNull();
  });

  it('drops leading zeros and a trailing mark', () => {
    expect(parsePasted('007', en)).toBe('7');
    expect(parsePasted('12.', en)).toBe('12');
  });
});

describe('stepDecimal (arrow keys and steppers, by tick size, bigint)', () => {
  const o = { precision: 8 };

  it('adds and subtracts one tick exactly', () => {
    expect(stepDecimal('83281.8', '0.1', 1, o)).toBe('83281.9');
    expect(stepDecimal('83281.8', '0.1', -1, o)).toBe('83281.7');
  });

  it('is exact where floats drift (0.1 + 0.2)', () => {
    expect(stepDecimal('0.1', '0.2', 1, o)).toBe('0.3');
    expect(stepDecimal('0.3', '0.1', -1, o)).toBe('0.2');
  });

  it('keeps the larger number of decimals of the value and the tick', () => {
    expect(stepDecimal('5.5', '0.01', 1, o)).toBe('5.51');
    expect(stepDecimal('5.00', '1', 1, o)).toBe('6.00');
    expect(stepDecimal('5', '0.1', 1, o)).toBe('5.1');
  });

  it('treats an empty value as 0 and finishes an unfinished dot', () => {
    expect(stepDecimal('', '0.01', 1, o)).toBe('0.01');
    expect(stepDecimal('12.', '1', 1, o)).toBe('13');
  });

  it('never goes below the minimum (default 0)', () => {
    expect(stepDecimal('0.05', '0.1', -1, o)).toBe('0.00');
    expect(stepDecimal('', '1', -1, o)).toBe('0');
    expect(stepDecimal('1', '1', -1, { ...o, min: '1' })).toBe('1');
  });

  it('never goes above the maximum', () => {
    expect(stepDecimal('9.95', '0.1', 1, { ...o, max: '10' })).toBe('10.00');
    expect(stepDecimal('10', '0.1', 1, { ...o, max: '10' })).toBe('10');
  });

  it('moves several ticks with a multiplier', () => {
    expect(stepDecimal('1', '0.5', 1, { ...o, multiplier: 10 })).toBe('6.0');
  });

  it('never grows beyond the precision', () => {
    expect(stepDecimal('1.23', '0.001', 1, { precision: 2 })).toBe('1.23');
    expect(stepDecimal('1.23', '0.01', 1, { precision: 2 })).toBe('1.24');
  });

  it('is exact with 18 decimals (no float anywhere)', () => {
    expect(stepDecimal('0.000000000000000001', '0.000000000000000001', 1, { precision: 18 })).toBe('0.000000000000000002');
  });
});

describe('amount predicates', () => {
  it('recognises complete and positive amounts by digits only', () => {
    expect(isCompleteAmount('12')).toBe(true);
    expect(isCompleteAmount('0.05')).toBe(true);
    expect(isCompleteAmount('12.')).toBe(false);
    expect(isCompleteAmount('')).toBe(false);
    expect(isPositiveAmount('0.05')).toBe(true);
    expect(isPositiveAmount('0')).toBe(false);
    expect(isPositiveAmount('0.000')).toBe(false);
  });

});

describe('parsePasted (no silent misreads)', () => {
  it('reads grouped and locale amounts without losing a separator', () => {
    expect(parsePasted('1,234.5', { precision: 8 })).toBe('1234.5');
    expect(parsePasted('1.234,5', { precision: 8, decimalSeparator: ',' })).toBe('1234.5');
  });

  it('rejects exponent notation and letters between digits instead of misreading them', () => {
    const p8 = { precision: 8 };
    expect(parsePasted('1e5', p8)).toBeNull();
    expect(parsePasted('1E5', p8)).toBeNull();
    expect(parsePasted('1.5e-3', p8)).toBeNull();
    expect(parsePasted('1.5 BTC (2 orders)', p8)).toBeNull();
    expect(parsePasted('1x2', p8)).toBeNull();
  });
});
