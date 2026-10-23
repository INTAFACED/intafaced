import { describe, expect, it } from 'vitest';
import { futuresRefusal } from './refusals';

describe('futures refusal copy for the S19 doors', () => {
  it('says a delete does not close and that an overloaded door still takes a reduce', () => {
    const cancel = futuresRefusal({ code: 'trade.cancel_not_close' });
    expect(cancel.title.length).toBeGreaterThan(0);
    expect(cancel.body.length).toBeGreaterThan(0);
    expect(cancel.retryable).toBe(false);
    const overload = futuresRefusal({ code: 'trade.system_overload' });
    expect(overload.title.length).toBeGreaterThan(0);
    expect(overload.body.toLowerCase()).toContain('reduce');
  });
});
