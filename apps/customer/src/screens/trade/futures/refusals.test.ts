import { describe, expect, it } from 'vitest';
import { collateralRefusal, futuresRefusal } from './refusals';

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

describe('a margin class the venue does not take (J-derivatives-02 #4)', () => {
  it('names the venue the service names, and keeps the code and the cash rule', () => {
    const r = collateralRefusal('TEST venue');
    expect(r.code).toBe('trade.unsupported_collateral_class');
    expect(r.title).toBe('Only cash can be posted as margin');
    expect(r.body).toContain('TEST venue does not take');
    expect(r.retryable).toBe(false);
  });
  it('without a venue from the service, names none rather than guess one', () => {
    expect(collateralRefusal(undefined)).toEqual(futuresRefusal({ code: 'trade.unsupported_collateral_class' }));
  });
});
