import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { AlertOwnerValues, planOf } from './owner-values.js';

const noDb = (() => {
  throw new Error('no database read before the checks pass');
}) as never;
const founder = { sub: '00000000-0000-4000-8000-000000000001', scopes: ['admin:read', 'admin:write'] } as unknown as Principal;
const support = { sub: '00000000-0000-4000-8000-000000000002', scopes: ['admin:read'] } as unknown as Principal;
const values = new AlertOwnerValues(noDb, { maxActivePrice: 20, triggerLogDays: 7 });
const set = {
  key: 'priceQuota' as const,
  plan: 'none' as const,
  value: 2,
  expectedVersion: '0',
  reason: 'TEST quota for a journey',
  clientRequestId: 'k1',
};

describe('planOf (J-charts-desk-18 #6)', () => {
  it('reads the session verification level as the plan, and anything else as none', () => {
    expect(planOf('full')).toBe('full');
    expect(planOf('institutional')).toBe('institutional');
    expect(planOf(undefined)).toBe('none');
    expect(planOf('gold')).toBe('none');
  });
});

describe('AlertOwnerValues.set refuses before it writes (J-charts-desk-18 #6)', () => {
  it('refuses a caller without admin:write', async () => {
    await expect(values.set(support, set)).rejects.toMatchObject({ code: 'notify.owner_value_forbidden' });
  });
  it('refuses a short reason', async () => {
    await expect(values.set(founder, { ...set, reason: 'short' })).rejects.toMatchObject({ code: 'notify.owner_value_reason_required' });
  });
  it('refuses a quota with no plan, a zero, a fraction and a value past the bound', async () => {
    await expect(values.set(founder, { ...set, plan: null })).rejects.toMatchObject({ code: 'notify.owner_value_invalid' });
    for (const value of [0, 1.5, 10_001]) {
      await expect(values.set(founder, { ...set, value })).rejects.toMatchObject({ code: 'notify.owner_value_invalid' });
    }
  });
});
