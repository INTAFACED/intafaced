import { describe, expect, it } from 'vitest';
import { blurDecimalValue, displayDecimal, keyToStep, nextDecimalValue, pastedDecimalValue, stepValueForKey } from './input-logic.js';

const p8 = { precision: 8 };
const p18 = { precision: 18 };

describe('nextDecimalValue (typing)', () => {
  it('keeps 0.1 and 0.2 exactly as typed', () => {
    expect(nextDecimalValue('', '0.1', p8)).toBe('0.1');
    expect(nextDecimalValue('', '0.2', p8)).toBe('0.2');
  });

  it('keeps every digit of an 18-decimal string at precision 18', () => {
    const v = '0.123456789012345678';
    expect(nextDecimalValue('', v, p18)).toBe(v);
    expect(nextDecimalValue(v, displayDecimal(v), p18)).toBe(v);
  });

  it('refuses the 19th decimal while typing (value unchanged)', () => {
    const prev = '0.123456789012345678';
    expect(nextDecimalValue(prev, `${prev}9`, p18)).toBe(prev);
  });

  it('refuses a second decimal mark and a mix of both marks', () => {
    expect(nextDecimalValue('1.5', '1.5.', p8)).toBe('1.5');
    expect(nextDecimalValue('1.5', '1.5,', p8)).toBe('1.5');
  });

  it('refuses any decimal mark at precision 0', () => {
    expect(nextDecimalValue('12', '12.', { precision: 0 })).toBe('12');
  });

  it('keeps an unfinished "12." so typing can continue', () => {
    expect(nextDecimalValue('12', '12.', p8)).toBe('12.');
  });

  it('turns ".5" into "0.5" and strips leading zeros', () => {
    expect(nextDecimalValue('', '.5', p8)).toBe('0.5');
    expect(nextDecimalValue('0', '05', p8)).toBe('5');
  });

  it('drops letters and symbols', () => {
    expect(nextDecimalValue('12', '12a', p8)).toBe('12');
    expect(nextDecimalValue('', 'abc', p8)).toBe('');
  });

  it('an empty box gives an empty value', () => {
    expect(nextDecimalValue('5', '', p8)).toBe('');
    expect(nextDecimalValue('', '', p8)).toBe('');
  });

  it('has no negatives: "-" is dropped exactly as parseTyped does', () => {
    expect(nextDecimalValue('', '-', p8)).toBe('');
    expect(nextDecimalValue('', '-5', p8)).toBe('5');
    expect(nextDecimalValue('5', '-', p8)).toBe('');
  });

  it('reads the comma keyboard: "," is the mark and the value stays canonical', () => {
    const opts = { precision: 8, decimalSeparator: ',' as const };
    expect(nextDecimalValue('', '0,25', opts)).toBe('0.25');
    expect(displayDecimal('0.25', ',')).toBe('0,25');
    expect(nextDecimalValue('0.25', displayDecimal('0.25', ','), opts)).toBe('0.25');
  });

  it('a huge integer part survives value -> display -> value untouched', () => {
    const v = '123456789012345678901234567890.000000000000000001';
    expect(nextDecimalValue('', displayDecimal(v), p18)).toBe(v);
    expect(nextDecimalValue(v, v, p18)).toBe(v);
    const c = displayDecimal(v, ',');
    expect(nextDecimalValue(v, c, { precision: 18, decimalSeparator: ',' })).toBe(v);
  });
});

describe('pastedDecimalValue', () => {
  it('normalises "1,234.5678"', () => {
    expect(pastedDecimalValue('', '1,234.5678', p8)).toBe('1234.5678');
  });

  it('normalises currency text and European grouping', () => {
    expect(pastedDecimalValue('', '$1,234.56', p8)).toBe('1234.56');
    expect(pastedDecimalValue('', '1.234,56', p8)).toBe('1234.56');
    expect(pastedDecimalValue('', '0.5 BTC', p8)).toBe('0.5');
  });

  it('keeps all 18 decimals at precision 18', () => {
    expect(pastedDecimalValue('', '0.123456789012345678', p18)).toBe('0.123456789012345678');
  });

  it('cuts the 19th decimal DOWN, never rounds up', () => {
    expect(pastedDecimalValue('', '0.1234567890123456789', p18)).toBe('0.123456789012345678');
    expect(pastedDecimalValue('', '0.1999999999999999999', p18)).toBe('0.199999999999999999');
    expect(pastedDecimalValue('', '1.999', { precision: 2 })).toBe('1.99');
  });

  it('keeps a huge integer exactly', () => {
    const v = '123456789012345678901234567890.000000000000000001';
    expect(pastedDecimalValue('', v, p18)).toBe(v);
  });

  it('leaves the value unchanged when the text is not an amount', () => {
    expect(pastedDecimalValue('7', 'hello', p8)).toBe('7');
    expect(pastedDecimalValue('7', '1e5', p8)).toBe('7');
  });

  it('drops the minus sign, as parsePasted does', () => {
    expect(pastedDecimalValue('', '-5', p8)).toBe('5');
  });
});

describe('blurDecimalValue', () => {
  it('drops an unfinished trailing dot only', () => {
    expect(blurDecimalValue('12.')).toBe('12');
    expect(blurDecimalValue('12.5')).toBe('12.5');
    expect(blurDecimalValue('')).toBe('');
    expect(blurDecimalValue('0.')).toBe('0');
  });
});

describe('keyToStep', () => {
  it('maps arrows and page keys', () => {
    expect(keyToStep('ArrowUp')).toEqual({ direction: 1, ticks: 1 });
    expect(keyToStep('ArrowDown')).toEqual({ direction: -1, ticks: 1 });
    expect(keyToStep('ArrowUp', true)).toEqual({ direction: 1, ticks: 10 });
    expect(keyToStep('ArrowDown', true)).toEqual({ direction: -1, ticks: 10 });
    expect(keyToStep('PageUp')).toEqual({ direction: 1, ticks: 10 });
    expect(keyToStep('PageDown')).toEqual({ direction: -1, ticks: 10 });
  });

  it('ignores other keys', () => {
    expect(keyToStep('a')).toBeNull();
    expect(keyToStep('Enter', true)).toBeNull();
  });
});

describe('stepValueForKey (exact decimal stepping)', () => {
  const opts = { precision: 8 };

  it('0.1 + 0.1 is exactly 0.2', () => {
    expect(stepValueForKey('0.1', '0.1', 'ArrowUp', false, opts)).toBe('0.2');
  });

  it('0.2 + 0.1 is exactly 0.3, never 0.30000000000000004', () => {
    expect(stepValueForKey('0.2', '0.1', 'ArrowUp', false, opts)).toBe('0.3');
  });

  it('0.3 - 0.1 is exactly 0.2', () => {
    expect(stepValueForKey('0.3', '0.1', 'ArrowDown', false, opts)).toBe('0.2');
  });

  it('Shift moves ten ticks', () => {
    expect(stepValueForKey('1', '0.1', 'ArrowUp', true, opts)).toBe('2.0');
  });

  it('an empty value steps from zero', () => {
    expect(stepValueForKey('', '0.5', 'ArrowUp', false, opts)).toBe('0.5');
  });

  it('stops at the minimum (default 0) and returns the same text', () => {
    expect(stepValueForKey('0.05', '0.1', 'ArrowDown', false, opts)).toBe('0.00');
    expect(stepValueForKey('0', '0.1', 'ArrowDown', false, opts)).toBe('0');
  });

  it('respects max', () => {
    expect(stepValueForKey('9.9', '0.1', 'ArrowUp', true, { ...opts, max: '10' })).toBe('10.0');
  });

  it('steps 18-decimal values without losing a digit', () => {
    expect(stepValueForKey('0.123456789012345678', '0.000000000000000001', 'ArrowUp', false, p18)).toBe('0.123456789012345679');
  });

  it('steps a huge integer exactly', () => {
    expect(stepValueForKey('123456789012345678901234567890', '1', 'ArrowUp', false, p18)).toBe('123456789012345678901234567891');
  });

  it('returns null for keys that do not step', () => {
    expect(stepValueForKey('1', '0.1', 'a', false, opts)).toBeNull();
  });
});
