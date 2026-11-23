import { describe, expect, it } from 'vitest';
import { tokenAmount, usdDisplay } from './portfolio-format';

describe('portfolio figures', () => {
  it('shows dollars and cents, rounded half up, with the sign in front', () => {
    expect(usdDisplay('100')).toBe('$100.00');
    expect(usdDisplay('1250.5')).toBe('$1,250.50');
    expect(usdDisplay('-30')).toBe('−$30.00');
    expect(usdDisplay('89.999999')).toBe('$90.00');
    expect(usdDisplay('0.004')).toBe('$0.00');
    expect(usdDisplay('-0.004')).toBe('$0.00');
    expect(usdDisplay('123456789012345678901.125')).toBe('$123,456,789,012,345,678,901.13');
  });
  it('shows a token amount exactly, grouped, never rounded', () => {
    expect(tokenAmount('9850000001', 6)).toBe('9,850.000001');
    expect(tokenAmount('5000000000000000000', 18)).toBe('5');
  });
});
