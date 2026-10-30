import { describe, expect, it } from 'vitest';
import { merchantActivationSchema } from './merchant-activation.js';

describe('merchantActivationSchema', () => {
  it('a confirmed activation carries its time and an active status', () => {
    const at = '2026-10-29T10:00:00.000Z';
    expect(merchantActivationSchema.parse({ activation: 'confirmed', status: 'active', activatedAt: at })).toEqual({
      activation: 'confirmed',
      status: 'active',
      activatedAt: at,
    });
  });

  it('refuses a confirmed activation with no time, or on a business that is not active', () => {
    expect(merchantActivationSchema.safeParse({ activation: 'confirmed', status: 'active', activatedAt: null }).success).toBe(false);
    expect(
      merchantActivationSchema.safeParse({ activation: 'confirmed', status: 'suspended', activatedAt: '2026-10-29T10:00:00Z' }).success,
    ).toBe(false);
  });

  it('an unconfirmed activation has no time and names why', () => {
    expect(
      merchantActivationSchema.parse({ activation: 'unconfirmed', status: 'active', activatedAt: null, reason: 'no_activation_record' }),
    ).toMatchObject({ activation: 'unconfirmed', reason: 'no_activation_record' });
    expect(
      merchantActivationSchema.safeParse({
        activation: 'unconfirmed',
        status: 'active',
        activatedAt: '2026-10-29T10:00:00Z',
        reason: 'no_activation_record',
      }).success,
    ).toBe(false);
    expect(merchantActivationSchema.safeParse({ activation: 'unconfirmed', status: 'pending', activatedAt: null }).success).toBe(false);
  });

  it('refuses extra fields and any other state', () => {
    expect(
      merchantActivationSchema.safeParse({
        activation: 'confirmed',
        status: 'active',
        activatedAt: '2026-10-29T10:00:00Z',
        screening: 'passed',
      }).success,
    ).toBe(false);
    expect(merchantActivationSchema.safeParse({ activation: 'unknown', status: 'active', activatedAt: null }).success).toBe(false);
  });
});
