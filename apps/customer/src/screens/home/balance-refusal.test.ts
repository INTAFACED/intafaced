import { describe, expect, it } from 'vitest';
import { balanceRefusal } from './balance-refusal';

describe("Home's balance refusal (#10315)", () => {
  it('asks to verify with no support reference: the step is the way out, not a fault to quote', () => {
    const copy = balanceRefusal('kyc.required');
    expect(copy.title).toBe('Verify your identity first');
    expect(copy.reference).toBeUndefined();
    expect(copy.action?.href).toBe('/verification');
  });

  it('keeps the reference on a refusal the person may need to quote', () => {
    expect(balanceRefusal('denied.screening').reference).toMatch(/^Ref /);
  });
});
