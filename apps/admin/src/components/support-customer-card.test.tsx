import { describe, expect, it } from 'vitest';
import { consoleRefusedCard } from '@/lib/support/browser';
import { accountWords } from './support-customer-card';

const asOf = '2026-10-29T12:00:00.000Z';
const U = '33333333-3333-4333-8333-333333333333';

describe('the customer card never says "active" without a read', () => {
  it('names the state svc-identity gave', () => {
    const words = accountWords({
      asOf,
      account: { kind: 'ok', data: { status: 'read', state: { userId: U, status: 'frozen', kycTier: 'basic' }, readAt: asOf } },
    });
    expect(words).toEqual({ state: 'frozen', why: null, code: null });
  });
  it('is unread when identity could not be reached, when svc-support refused, and when nothing answered', () => {
    expect(accountWords({ asOf, account: { kind: 'ok', data: { status: 'unread', reason: 'plane_dark' } } })).toMatchObject({
      state: 'unread',
      code: 'plane_dark',
    });
    expect(
      accountWords({
        asOf,
        account: { kind: 'failed', message: 'not wired', code: 'support.identity_grounding_unwired', notBuilt: false, forbidden: false },
      }),
    ).toMatchObject({ state: 'unread', code: 'support.identity_grounding_unwired' });
    expect(accountWords(null).state).toBe('unread');
  });
  it("is unread with the console's own code when the console refused the read", () => {
    expect(accountWords(consoleRefusedCard(502, 'admin.upstream_unavailable'))).toMatchObject({
      state: 'unread',
      code: 'admin.upstream_unavailable',
    });
  });
});
