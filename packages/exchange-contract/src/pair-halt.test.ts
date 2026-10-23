/** SP-order-entry-03 review fix: circuit-breaker state on the market contract. */
import { describe, expect, it } from 'vitest';
import { pairHaltSchema } from './schemas.js';

describe('pairHaltSchema', () => {
  it('accepts halted and not-halted states', () => {
    expect(
      pairHaltSchema.safeParse({
        circuitBreaker: '500',
        refusesAllOrders: true,
        refusalCode: 'trade.circuit_breaker_reference_unset',
        riskVersion: '4',
      }).success,
    ).toBe(true);
    expect(
      pairHaltSchema.safeParse({ circuitBreaker: 'not set', refusesAllOrders: false, refusalCode: null, riskVersion: '0' }).success,
    ).toBe(true);
  });
  it('refuses a missing refusesAllOrders and an unknown refusal code', () => {
    expect(pairHaltSchema.safeParse({ circuitBreaker: '500', refusalCode: null, riskVersion: '4' }).success).toBe(false);
    expect(pairHaltSchema.safeParse({ circuitBreaker: '500', refusesAllOrders: true, refusalCode: 'x', riskVersion: '4' }).success).toBe(
      false,
    );
  });
});
