import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { AlertOwnerValues, parseAccountPlans, planOf } from './owner-values.js';

const noDb = (() => {
  throw new Error('no database read before the checks pass');
}) as never;
const founder = { sub: '00000000-0000-4000-8000-000000000001', scopes: ['admin:read', 'admin:write'] } as unknown as Principal;
const support = { sub: '00000000-0000-4000-8000-000000000002', scopes: ['admin:read'] } as unknown as Principal;
const TABLE = JSON.stringify({
  defaultPlanId: 'standard',
  plans: [
    { id: 'standard', name: 'TEST Standard', tier: 'standard', price: '0', assetId: 'USDT', period: 'month' },
    { id: 'plus', name: 'TEST Plus', tier: 'plus', price: '4.99', assetId: 'USDT', period: 'month' },
  ],
});
const plans = parseAccountPlans(TABLE);
const values = new AlertOwnerValues(noDb, { maxActivePrice: 20, triggerLogDays: 7 }, plans);
const set = {
  key: 'priceQuota' as const,
  plan: 'standard',
  value: 2,
  expectedVersion: '0',
  reason: 'TEST quota for a journey',
  clientRequestId: 'k1',
};

describe('the owner plan table (J-charts-desk-18 #6)', () => {
  it("reads the bank's table shape: the plan ids, their names and the default", () => {
    expect(plans).toEqual({
      defaultPlanId: 'standard',
      plans: [
        { id: 'standard', name: 'TEST Standard' },
        { id: 'plus', name: 'TEST Plus' },
      ],
    });
  });
  it('is not set when blank or not in shape, never a guessed plan', () => {
    expect(parseAccountPlans(undefined)).toBeNull();
    expect(parseAccountPlans('')).toBeNull();
    expect(parseAccountPlans('{"defaultPlanId":"gold","plans":[{"id":"standard","name":"S"}]}')).toBeNull();
    expect(parseAccountPlans('{"defaultPlanId":"a","plans":[{"id":"a","name":"A"},{"id":"a","name":"B"}]}')).toBeNull();
  });
  it("puts every person on the default plan, the bank's own rule, unless their own known plan is read", () => {
    expect(planOf(plans, undefined)).toBe('standard');
    expect(planOf(plans, 'plus')).toBe('plus');
    expect(planOf(plans, 'gold')).toBe('standard');
    expect(planOf(null, 'plus')).toBeNull();
  });
});

describe('AlertOwnerValues.set refuses before it writes (J-charts-desk-18 #6)', () => {
  it('refuses a caller without admin:write', async () => {
    await expect(values.set(support, set)).rejects.toMatchObject({ code: 'notify.owner_value_forbidden' });
  });
  it('refuses a short reason', async () => {
    await expect(values.set(founder, { ...set, reason: 'short' })).rejects.toMatchObject({ code: 'notify.owner_value_reason_required' });
  });
  it("refuses a quota for no plan or a plan not in the owner's table, and any quota while the table is not set", async () => {
    await expect(values.set(founder, { ...set, plan: null })).rejects.toMatchObject({ code: 'notify.owner_value_invalid' });
    await expect(values.set(founder, { ...set, plan: 'gold' })).rejects.toMatchObject({ code: 'notify.owner_value_invalid' });
    const unset = new AlertOwnerValues(noDb, { maxActivePrice: 20, triggerLogDays: 7 }, null);
    await expect(unset.set(founder, set)).rejects.toMatchObject({ code: 'notify.owner_value_invalid' });
  });
  it('refuses a zero, a fraction and a value past the bound', async () => {
    for (const value of [0, 1.5, 10_001]) {
      await expect(values.set(founder, { ...set, value })).rejects.toMatchObject({ code: 'notify.owner_value_invalid' });
    }
  });
});
