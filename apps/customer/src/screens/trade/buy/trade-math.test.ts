import { describe, expect, it } from 'vitest';
import {
  bpsRatio,
  ceilPlaces,
  ceilToStep,
  cutDecimal,
  divDown,
  divUp,
  floorToStep,
  isMultipleOf,
  mulDown,
  mulUp,
  dec,
  str,
} from './trade-math';

const d = (value: string) => dec(value)!;

describe('exact trade arithmetic', () => {
  it('multiplies and divides without a float, rounding the stated way', () => {
    expect(str(mulDown(d('0.00015'), d('65083.66')))).toBe('9.762549');
    expect(str(mulDown(d('0.1'), d('0.1')))).toBe('0.01');
    expect(mulUp(d('0.000000000000000001'), d('0.5'))).toBe(1n);
    expect(mulDown(d('0.000000000000000001'), d('0.5'))).toBe(0n);
    expect(str(divDown(d('10'), d('3'))!)).toBe('3.333333333333333333');
    expect(str(divUp(d('10'), d('3'))!)).toBe('3.333333333333333334');
    expect(divDown(d('1'), 0n)).toBeNull();
    expect(divUp(d('1'), 0n)).toBeNull();
  });

  it('floors to whole lots and never past the amount', () => {
    expect(str(floorToStep(d('0.0001537'), d('0.00001')))).toBe('0.00015');
    expect(str(floorToStep(d('5'), d('0.5')))).toBe('5');
    expect(floorToStep(d('0.000009'), d('0.00001'))).toBe(0n);
    expect(floorToStep(d('1'), 0n)).toBe(0n);
    expect(floorToStep(d('-1'), d('0.1'))).toBe(0n);
  });

  it('ceils the minimums it quotes', () => {
    expect(str(ceilToStep(d('0.000011'), d('0.00001')))).toBe('0.00002');
    expect(str(ceilToStep(d('0.00001'), d('0.00001')))).toBe('0.00001');
    expect(str(ceilPlaces(d('5.001'), 2))).toBe('5.01');
    expect(str(ceilPlaces(d('5'), 2))).toBe('5');
  });

  it('knows a multiple of a lot', () => {
    expect(isMultipleOf(d('0.00015'), d('0.00001'))).toBe(true);
    expect(isMultipleOf(d('0.000015'), d('0.00001'))).toBe(false);
    expect(isMultipleOf(d('1'), 0n)).toBe(false);
  });

  it('turns basis points into a ratio', () => {
    expect(str(bpsRatio(10))).toBe('0.001');
    expect(str(bpsRatio(20))).toBe('0.002');
    expect(str(bpsRatio(0))).toBe('0');
  });

  it('cuts a decimal string down to places without rounding up', () => {
    expect(cutDecimal('9.999999', 2)).toBe('9.99');
    expect(cutDecimal('1', 4)).toBe('1');
    expect(cutDecimal('abc', 2)).toBeNull();
  });
});
