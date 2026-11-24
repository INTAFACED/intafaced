import { describe, expect, it } from 'vitest';
import { signalAlertOrderSchema } from './trade-signal-alerts.js';

const ok = { side: 'buy', amount: '0.01', price: '60000' };

describe('signalAlertOrderSchema', () => {
  it('reads a decimal-string amount and price, trimmed', () => {
    expect(signalAlertOrderSchema.parse({ ...ok, amount: ' 0.01 ', token: 't' })).toEqual(ok);
  });

  it('refuses a JSON number amount or price, by that field: never coerced', () => {
    for (const field of ['amount', 'price'] as const) {
      const out = signalAlertOrderSchema.safeParse({ ...ok, [field]: 0.01 });
      expect(out.success).toBe(false);
      expect(out.error?.issues.map((i) => i.path[0])).toEqual([field]);
    }
  });

  it('refuses a negative, a percent, more than 18 places and a side other than buy or sell', () => {
    for (const bad of [{ amount: '-1' }, { amount: '50%' }, { price: '1.0000000000000000001' }, { side: 'reverse' }]) {
      expect(signalAlertOrderSchema.safeParse({ ...ok, ...bad }).success).toBe(false);
    }
  });
});
