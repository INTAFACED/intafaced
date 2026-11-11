import { describe, expect, it } from 'vitest';
import { consoleRefusedCard } from '@/lib/support/browser';
import { accountWords, orderWords } from './support-customer-card';

const asOf = '2026-10-29T12:00:00.000Z';
const U = '33333333-3333-4333-8333-333333333333';
const O = '44444444-4444-4444-8444-444444444444';
const NONE = { kind: 'ok', data: [] } as const;
const READ = { kind: 'ok', data: { status: 'unread', reason: 'plane_dark' } } as const;

describe('the customer card never says "active" without a read', () => {
  it('names the state svc-identity gave', () => {
    const words = accountWords({
      asOf,
      account: { kind: 'ok', data: { status: 'read', state: { userId: U, status: 'frozen', kycTier: 'basic' }, readAt: asOf } },
      orders: NONE,
    });
    expect(words).toEqual({ state: 'frozen', why: null, code: null });
  });
  it('is unread when identity could not be reached, when svc-support refused, and when nothing answered', () => {
    expect(accountWords({ asOf, account: { kind: 'ok', data: { status: 'unread', reason: 'plane_dark' } }, orders: NONE })).toMatchObject({
      state: 'unread',
      code: 'plane_dark',
    });
    expect(
      accountWords({
        asOf,
        account: { kind: 'failed', message: 'not wired', code: 'support.identity_grounding_unwired', notBuilt: false, forbidden: false },
        orders: NONE,
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

describe('the customer card says "none" for the related order only when it read none', () => {
  it('names the order the desk linked', () => {
    expect(orderWords({ asOf, account: READ, orders: { kind: 'ok', data: [O] } })).toEqual({ order: O, why: null, code: null });
  });
  it('says none when the request has no linked order', () => {
    expect(orderWords({ asOf, account: READ, orders: NONE })).toMatchObject({ order: 'none', code: null });
  });
  it('is unread, never none, when the links could not be read or nothing answered', () => {
    const orders = { kind: 'failed', message: 'down', code: 'support.down', notBuilt: false, forbidden: false } as const;
    expect(orderWords({ asOf, account: READ, orders })).toEqual({ order: 'unread', why: 'down', code: 'support.down' });
    expect(orderWords(consoleRefusedCard(502, 'admin.upstream_refused'))).toMatchObject({
      order: 'unread',
      code: 'admin.upstream_refused',
    });
    expect(orderWords(null).order).toBe('unread');
  });
});
