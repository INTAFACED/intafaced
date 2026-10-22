import { describe, expect, it } from 'vitest';
import {
  SUBSCRIPTION_EVENT_TYPES,
  SUBSCRIPTION_RETRY_ATTEMPTS_MAX,
  subscriptionRetryPolicySetInputSchema,
  subscriptionRetryValuesComplete,
  subscriptionRetryValuesSchema,
  subscriptionSearchInputSchema,
} from './subscription-retry.js';

const M = '11111111-1111-4111-8111-111111111111';

describe('M-bill-04 subscription retry contracts', () => {
  it('owner values have no default: an empty policy parses as all null and is not complete', () => {
    const v = subscriptionRetryValuesSchema.parse({ attempts: null, spacingHours: null, finalAction: null });
    expect(v).toEqual({ attempts: null, spacingHours: null, finalAction: null });
    expect(subscriptionRetryValuesComplete(v)).toBe(false);
    expect(subscriptionRetryValuesSchema.safeParse({}).success).toBe(false);
  });

  it('one missing value keeps the policy incomplete', () => {
    expect(subscriptionRetryValuesComplete({ attempts: 2, spacingHours: 24, finalAction: null })).toBe(false);
    expect(subscriptionRetryValuesComplete({ attempts: 2, spacingHours: 24, finalAction: 'cancel' })).toBe(true);
  });

  it('attempts cannot exceed the charge-cycle bound of 3', () => {
    expect(SUBSCRIPTION_RETRY_ATTEMPTS_MAX).toBe(3);
    expect(subscriptionRetryValuesSchema.safeParse({ attempts: 4, spacingHours: 24, finalAction: 'cancel' }).success).toBe(false);
    expect(subscriptionRetryValuesSchema.safeParse({ attempts: 0, spacingHours: 24, finalAction: 'cancel' }).success).toBe(false);
  });

  it('a policy write names the version it read', () => {
    const base = { merchantId: M, values: { attempts: 1, spacingHours: 24, finalAction: 'mark_unpaid' }, autoRetry: false };
    expect(subscriptionRetryPolicySetInputSchema.safeParse(base).success).toBe(false);
    expect(subscriptionRetryPolicySetInputSchema.safeParse({ ...base, expectedVersion: 0 }).success).toBe(true);
  });

  it('the event catalogue lists the eight subscription events', () => {
    expect(SUBSCRIPTION_EVENT_TYPES).toHaveLength(8);
    expect(SUBSCRIPTION_EVENT_TYPES).toContain('subscription.payment_failed');
    expect(SUBSCRIPTION_EVENT_TYPES).toContain('subscription.recovered');
  });

  it('search refuses an inverted date window', () => {
    expect(
      subscriptionSearchInputSchema.safeParse({ merchantId: M, from: '2026-02-01T00:00:00Z', to: '2026-01-01T00:00:00Z' }).success,
    ).toBe(false);
    expect(subscriptionSearchInputSchema.parse({ merchantId: M }).limit).toBe(25);
  });
});
