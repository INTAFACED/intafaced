import { describe, expect, it } from 'vitest';
import { withdrawalAllowanceInputSchema, withdrawalAllowanceSchema } from './withdrawal-allowance.js';

/** TEST figures only. */
const view = {
  tier: 'basic',
  assetId: 'USDT',
  base: { perTx: '50', rolling24h: '100' },
  override: { perTx: '150', rolling24h: null, expiresAt: '2026-10-24T23:00:00.000Z' },
  perTx: '150',
  rolling24h: '100',
  used24h: '0',
  remaining: { perTx: '150', rolling24h: '100' },
  maxNow: '100',
};

describe('withdrawal allowance contract', () => {
  it('carries the base, an override in force, the figures in force and what is left as decimal strings', () => {
    expect(withdrawalAllowanceSchema.parse(view)).toEqual(view);
    expect(withdrawalAllowanceSchema.parse({ ...view, override: null }).override).toBeNull();
  });

  it('refuses a number, a negative, a missing base, an end time without a zone and any extra field', () => {
    for (const bad of [
      { ...view, maxNow: 100 },
      { ...view, used24h: '-1' },
      { ...view, base: undefined },
      { ...view, override: { ...view.override, expiresAt: '2026-10-24 23:00' } },
      { ...view, extra: true },
    ]) {
      expect(withdrawalAllowanceSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('asks for one customer by id and one asset', () => {
    expect(withdrawalAllowanceInputSchema.safeParse({ userId: '11111111-1111-4111-8111-111111111111', assetId: 'USDT' }).success).toBe(
      true,
    );
    expect(withdrawalAllowanceInputSchema.safeParse({ userId: 'someone', assetId: 'USDT' }).success).toBe(false);
    expect(withdrawalAllowanceInputSchema.safeParse({ userId: '11111111-1111-4111-8111-111111111111', assetId: '' }).success).toBe(false);
  });
});
