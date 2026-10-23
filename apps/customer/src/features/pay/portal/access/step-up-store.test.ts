import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createApiClient, setScopedBearer, type ApiResult } from '../../../../shared/api';
import { createStepUpStore, mintPayStepUp, REUSE_MARGIN_MS, TOKEN_MAX_MS, type StepUpSnapshot } from './step-up-store';
import { stepUpExpired, stepUpRequired, stepUpWords, stepUpRefusalText } from './step-up-words';

// TEST data only: tokens and ids here are made up for the test and open nothing.
const USER = '22222222-2222-4222-8222-222222222222';
const OTHER_USER = '33333333-3333-4333-8333-333333333333';
const SHOP = '11111111-1111-4111-8111-111111111111';
const OTHER_SHOP = '44444444-4444-4444-8444-444444444444';

const minted = (clock: { now: number }, over: Partial<{ scopes: string[]; ms: number; refreshable: boolean }> = {}) => ({
  accessToken: 'TEST-confirm-token',
  expiresAt: new Date(clock.now + (over.ms ?? TOKEN_MAX_MS)).toISOString(),
  scopes: over.scopes ?? ['pay:read', 'pay:refund'],
  refreshable: over.refreshable ?? false,
});
function setup() {
  const clock = { now: Date.UTC(2026, 9, 18, 9, 0, 0) };
  const store = createStepUpStore(() => clock.now);
  store.bind({ userId: USER, merchantId: SHOP });
  return { clock, store };
}
afterEach(() => {
  setScopedBearer(null);
  vi.useRealTimers();
});

describe('the confirmation token', () => {
  it('is held for the money call it was minted for, and for no other', () => {
    const { clock, store } = setup();
    expect(store.remember('refund', minted(clock))).toBe(true);
    expect(store.bearerFor('payment.refund')).toBe('TEST-confirm-token');
    // A payout needs the payout scope; a refund token is not offered to it. Reads and everything else keep the session.
    for (const other of ['settlement.payout', 'merchantControl.approvals.request', 'conversion.execute', 'payment.list', 'merchant.me'])
      expect(store.bearerFor(other), other).toBeUndefined();
  });
  it('covers every payout call with a payout token, and approvals decisions stay on the session', () => {
    const { clock, store } = setup();
    store.remember('payout', minted(clock, { scopes: ['pay:payout'] }));
    for (const call of ['settlement.payout', 'merchantControl.approvals.request', 'merchantControl.approvals.cancel', 'conversion.execute'])
      expect(store.bearerFor(call), call).toBe('TEST-confirm-token');
    expect(store.bearerFor('merchantControl.approvals.decide')).toBeUndefined();
    expect(store.bearerFor('payment.refund')).toBeUndefined();
  });
  it('is refused when it is not the scope asked for, can be renewed, or has no real expiry', () => {
    const { clock, store } = setup();
    expect(store.remember('refund', minted(clock, { scopes: ['pay:read'] }))).toBe(false);
    expect(store.remember('refund', minted(clock, { refreshable: true }))).toBe(false);
    expect(store.remember('refund', { ...minted(clock), expiresAt: 'soon' })).toBe(false);
    expect(store.remember('refund', { accessToken: '' })).toBe(false);
    expect(store.bearerFor('payment.refund')).toBeUndefined();
  });
  it('is held no longer than ten minutes, whatever the reply says', () => {
    const { clock, store } = setup();
    store.remember('refund', minted(clock, { ms: 3_600_000 }));
    clock.now += TOKEN_MAX_MS + 1;
    expect(store.bearerFor('payment.refund')).toBeUndefined();
    expect(store.minutesLeft('refund')).toBeNull();
  });
  it('counts the token’s own lifetime (exp - iat) from now, not from the reply’s clock', () => {
    const { clock, store } = setup();
    const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    // A reply whose clock is hours off (expiresAt in the past) still holds for its own 120 s, counted from now.
    const jwt = `${part({ alg: 'HS256' })}.${part({ iat: 1_000_000, exp: 1_000_120 })}.sig`;
    const skewed = { ...minted(clock), accessToken: jwt, expiresAt: new Date(clock.now - 3 * 3_600_000).toISOString() };
    expect(store.remember('refund', skewed)).toBe(true);
    expect(store.minutesLeft('refund')).toBe(2);
    clock.now += 120_001;
    expect(store.bearerFor('payment.refund')).toBeUndefined();
    // a lifetime longer than ten minutes is cut to ten
    const long = `${part({ alg: 'HS256' })}.${part({ iat: 1, exp: 100_000 })}.sig`;
    store.remember('refund', { ...minted(clock), accessToken: long });
    clock.now += TOKEN_MAX_MS + 1;
    expect(store.bearerFor('payment.refund')).toBeUndefined();
  });
  it('is not reused when little is left, so a review that takes a moment never meets an expired token', () => {
    const { clock, store } = setup();
    store.remember('refund', minted(clock));
    expect(store.holds('refund')).toBe(true);
    clock.now += TOKEN_MAX_MS - REUSE_MARGIN_MS + 1;
    expect(store.holds('refund')).toBe(false);
    // Still valid for a call already in hand, until it truly runs out.
    expect(store.bearerFor('payment.refund')).toBe('TEST-confirm-token');
  });
  it('says only how many minutes are left, never the token or a time', () => {
    const { clock, store } = setup();
    store.remember('refund', minted(clock));
    expect(store.minutesLeft('refund')).toBe(10);
    clock.now += 9 * 60_000 + 5_000;
    expect(store.minutesLeft('refund')).toBe(1);
  });
  it('is dropped on expiry (by timer), sign-out, a different person, a different business, and leaving the portal', () => {
    vi.useFakeTimers();
    const first = setup();
    first.store.remember('refund', minted(first.clock));
    vi.advanceTimersByTime(TOKEN_MAX_MS + 100);
    first.clock.now += TOKEN_MAX_MS + 100;
    expect(first.store.minutesLeft('refund')).toBeNull();

    for (const change of [
      { userId: null, merchantId: null },
      { userId: OTHER_USER, merchantId: SHOP },
      { userId: USER, merchantId: OTHER_SHOP },
    ]) {
      const { clock, store } = setup();
      store.remember('refund', minted(clock));
      store.bind(change);
      store.bind({ userId: USER, merchantId: SHOP });
      expect(store.bearerFor('payment.refund'), JSON.stringify(change)).toBeUndefined();
    }
    const { clock, store } = setup();
    store.remember('refund', minted(clock));
    // A page change unmounts and mounts again in the same turn: the confirmation survives that...
    store.unbind();
    store.bind({ userId: USER, merchantId: SHOP });
    vi.advanceTimersByTime(10);
    expect(store.bearerFor('payment.refund')).toBe('TEST-confirm-token');
    // ...and does not survive leaving the portal.
    store.unbind();
    vi.advanceTimersByTime(10);
    expect(store.bearerFor('payment.refund')).toBeUndefined();
  });
  it('is never written to storage', () => {
    const writes: string[] = [];
    const spy = { setItem: (k: string, v: string) => writes.push(`${k}=${v}`), getItem: () => null, removeItem: () => undefined };
    vi.stubGlobal('localStorage', spy);
    vi.stubGlobal('sessionStorage', spy);
    try {
      const { clock, store } = setup();
      store.remember('refund', minted(clock));
    } finally {
      vi.unstubAllGlobals();
    }
    expect(writes).toEqual([]);
  });
});

describe('asking, and asking again', () => {
  const answerWith = (store: ReturnType<typeof createStepUpStore>, decide: (ask: NonNullable<StepUpSnapshot['ask']>) => void) => {
    const answered = new Set<number>();
    return store.subscribe(() => {
      const { ask } = store.getSnapshot();
      if (ask && !answered.has(ask.id)) {
        answered.add(ask.id);
        queueMicrotask(() => decide(ask));
      }
    });
  };
  it('asks once, shares the answer with a second asker, and does not ask again while the token holds', async () => {
    const { clock, store } = setup();
    let asked = 0;
    answerWith(store, () => {
      asked += 1;
      store.remember('refund', minted(clock));
      store.confirmed();
    });
    const [a, b] = await Promise.all([store.ensure('refund'), store.ensure('refund')]);
    expect([a, b]).toEqual([true, true]);
    expect(await store.ensure('refund')).toBe(true);
    expect(asked).toBe(1);
  });
  it('answers false when the person declines, and when no portal is on screen to ask', async () => {
    const { store } = setup();
    const stop = answerWith(store, () => store.declined());
    expect(await store.ensure('payout')).toBe(false);
    stop();
    store.bind({ userId: null, merchantId: null });
    expect(store.canAsk).toBe(false);
    expect(await store.ensure('payout')).toBe(false);
  });
  it('asks again after the token ran out, with the same call sent twice', async () => {
    const { clock, store } = setup();
    const kinds: boolean[] = [];
    answerWith(store, (ask) => {
      kinds.push(ask.expired);
      store.remember('payout', minted(clock, { scopes: ['pay:payout'] }));
      store.confirmed();
    });
    const sent: string[] = [];
    // The first send is turned away (the token expired in between). The second goes out with the very same input.
    const send = vi
      .fn<() => Promise<ApiResult<{ id: string }>>>()
      .mockImplementationOnce(async () => {
        sent.push('first');
        return { ok: false, reason: 'unauthorized', message: 'no', status: 401 };
      })
      .mockImplementationOnce(async () => {
        sent.push('second');
        return { ok: true, data: { id: 'TEST-payout' } };
      });
    const result = await store.run('payout', send, stepUpWords);
    expect(result).toEqual({ ok: true, data: { id: 'TEST-payout' } });
    expect(sent).toEqual(['first', 'second']);
    // The first question was the ordinary one; the second says the confirmation expired.
    expect(kinds).toEqual([false, true]);
  });
  it('does not resend a refusal that is not about the token, and does not resend a lost reply', async () => {
    const { clock, store } = setup();
    store.remember('payout', minted(clock, { scopes: ['pay:payout'] }));
    for (const failed of [
      { ok: false as const, reason: 'uncertain' as const, message: 'lost' },
      { ok: false as const, reason: 'forbidden' as const, message: 'no', code: 'pay.approval_forbidden' },
      { ok: false as const, reason: 'error' as const, message: 'bad', code: 'pay.control_invalid' },
    ]) {
      const send = vi.fn(async (): Promise<ApiResult<never>> => failed);
      expect(await store.run('payout', send, stepUpWords)).toEqual(failed);
      expect(send).toHaveBeenCalledTimes(1);
    }
  });
  it('sends nothing when the person declines the second confirmation, and says the confirmation expired', async () => {
    const { clock, store } = setup();
    store.remember('payout', minted(clock, { scopes: ['pay:payout'] }));
    answerWith(store, () => store.declined());
    const send = vi.fn(async (): Promise<ApiResult<never>> => ({ ok: false, reason: 'unauthorized', message: 'no' }));
    const result = await store.run('payout', send, stepUpWords);
    expect(send).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: false, message: 'That confirmation expired. Confirm again.' });
  });
  it('sends nothing at all when the first confirmation is declined', async () => {
    const { store } = setup();
    answerWith(store, () => store.declined());
    const send = vi.fn(async (): Promise<ApiResult<never>> => ({ ok: true, data: undefined as never }));
    expect(await store.run('refund', send, stepUpWords)).toMatchObject({
      ok: false,
      message: "Confirm it's you with a passkey or authenticator code.",
    });
    expect(send).not.toHaveBeenCalled();
  });
});

describe('through the transport', () => {
  it('sends the token on the money call only, and the normal session on everything else, even after a normal refresh', async () => {
    const { clock, store } = setup();
    store.remember('refund', minted(clock));
    const seen: Array<[string, string | undefined]> = [];
    let session = 'SESSION-1';
    const api = createApiClient({
      token: () => session,
      fetch: async (url, init) => {
        seen.push([String(url).split('/trpc/')[1]!, (init?.headers as Record<string, string>).authorization]);
        return new Response(JSON.stringify({ result: { data: {} } }));
      },
    });
    setScopedBearer((module, procedure) => (module === 'pay' ? store.bearerFor(procedure) : undefined));
    await api.mutate('pay', 'payment.refund', {}, z.unknown());
    session = 'SESSION-2'; // an ordinary refresh changes the session token; it never touches the confirmation token
    await api.mutate('pay', 'merchant.createLink', {}, z.unknown());
    await api.mutate('identity', 'auth.refresh', {}, z.unknown());
    expect(seen).toEqual([
      ['payment.refund', 'Bearer TEST-confirm-token'],
      ['merchant.createLink', 'Bearer SESSION-2'],
      ['auth.refresh', 'Bearer SESSION-2'],
    ]);
  });
  it('asks identity to mint under the normal session, naming the business and one scope, and a wrong code keeps the session', async () => {
    const calls: Array<{ url: string; auth: string | undefined; body: unknown }> = [];
    const ended: Array<string | undefined> = [];
    const api = createApiClient({
      token: () => 'SESSION-1',
      onUnauthorized: (t) => ended.push(t),
      fetch: async (url, init) => {
        calls.push({
          url: String(url),
          auth: (init?.headers as Record<string, string>).authorization,
          body: JSON.parse(String(init?.body)),
        });
        return new Response(
          JSON.stringify({ error: { message: 'x', data: { code: 'UNAUTHORIZED', cause: { code: 'auth.mfa_invalid' } } } }),
          { status: 401 },
        );
      },
    });
    const result = await mintPayStepUp(api, { merchantId: SHOP, kind: 'refund', proof: { totpCode: '000000' } });
    expect(calls[0]).toMatchObject({
      url: '/api/identity/trpc/auth.stepUpPay',
      auth: 'Bearer SESSION-1',
      body: { merchantId: SHOP, scopes: ['pay:refund'], factorProof: { totpCode: '000000' } },
    });
    expect(result).toMatchObject({ ok: false, code: 'auth.mfa_invalid' });
    expect(ended).toEqual([]);
    expect(stepUpRefusalText(result as Extract<typeof result, { ok: false }>)).toBe(
      "That code didn't match. Check your authenticator app and try again.",
    );
  });
});

describe('the refusal map, in plain words', () => {
  const fail = (code: string | undefined, message: string, reason: 'error' | 'forbidden' | 'unauthorized' | 'unreachable' = 'error') =>
    ({ ok: false, reason, code, message }) as Extract<ApiResult<unknown>, { ok: false }>;
  it.each([
    ['auth.step_up_required', 'x', "Confirm it's you with a passkey or authenticator code."],
    ['auth.step_up_expired', 'x', 'That confirmation expired. Confirm again.'],
    ['auth.mfa_invalid', 'x', "That code didn't match. Check your authenticator app and try again."],
    [
      'auth.mfa_not_enrolled',
      'x',
      'No authenticator app is saved on this account. Use a passkey, or add an authenticator app in Security settings.',
    ],
    [
      'auth.webauthn_not_enrolled',
      'x',
      'No passkey is saved on this account. Enter your authenticator code, or add a passkey in Security settings.',
    ],
    [
      'pay.role_not_allowed',
      'Your role on this merchant does not allow refunds.create',
      'Your role on this business does not allow refunds. Ask the account owner.',
    ],
    [
      'pay.role_not_allowed',
      'Your role on this merchant does not allow payout.send',
      'Your role on this business does not allow payouts. Ask the account owner.',
    ],
  ])('%s reads in words', (code, message, words) => {
    expect(stepUpRefusalText(fail(code, message))).toBe(words);
  });
  it('words the API-key and sub-account refusal, which has no code', () => {
    expect(stepUpRefusalText(fail(undefined, 'API keys and sub-accounts cannot confirm a payment', 'forbidden'))).toBe(
      'API keys and sub-accounts cannot confirm a payment.',
    );
  });
  it('never shows a code, and falls back to the portal words for a failure of another kind', () => {
    for (const result of [fail('auth.something_new', 'internal detail', 'unreachable'), stepUpRequired(), stepUpExpired()])
      expect(stepUpRefusalText(result)).not.toMatch(/auth\.|pay\.|_/);
  });
});
