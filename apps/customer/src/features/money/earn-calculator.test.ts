import { describe, expect, it } from 'vitest';
import { CALCULATOR_MAX_DAYS, earnCalculation } from './earn-calculator';

describe('earnCalculation', () => {
  it('pays each day as the bank does, rounded down, and a period as that many days', () => {
    // 1000 at 36.5% is exactly 1 a day.
    expect(earnCalculation({ amount: '1000', aprBps: 3650, days: 30 })).toEqual({ perDay: '1', total: '30', days: 30 });
    // 100 at 1.25%: 1.25 a year, 0.003424657534246575 a day (the 18th place cut down), 30 days of that.
    expect(earnCalculation({ amount: '100', aprBps: 125, days: 30 })).toEqual({
      perDay: '0.003424657534246575',
      total: '0.10273972602739725',
      days: 30,
    });
  });

  it('works out nothing for an amount, rate or period it cannot read', () => {
    for (const amount of ['', '0', '-1', 'abc', '1.2.3']) expect(earnCalculation({ amount, aprBps: 125, days: 30 })).toBeNull();
    for (const days of [0, -1, 1.5, CALCULATOR_MAX_DAYS + 1]) expect(earnCalculation({ amount: '100', aprBps: 125, days })).toBeNull();
    expect(earnCalculation({ amount: '100', aprBps: -1, days: 30 })).toBeNull();
    expect(earnCalculation({ amount: '100', aprBps: 0, days: 30 })).toEqual({ perDay: '0', total: '0', days: 30 });
  });
});
