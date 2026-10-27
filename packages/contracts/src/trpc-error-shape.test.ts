import { describe, expect, it } from 'vitest';
import { TRPCError } from '@trpc/server';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { previewRefusal } from './preview-refusal.js';
import {
  algoRefusalDetails,
  previewRefusalOf,
  withdrawalAllowanceOf,
  p2pLimitOf,
  publicProcedure,
  retryAfterSecondsOf,
  accountStateOf,
  deviceAuthorisationOf,
  secondStepOf,
  conflictProfile,
  router,
  type Context,
} from './trpc.js';

/** Stand-in with the same shape as svc-identity's AuthError (a different class from @intafaced/auth's). */
class FakeAuthError extends Error {
  constructor(
    readonly code: string,
    readonly details?: { retryAfterSeconds?: number; accountState?: unknown },
  ) {
    super('refused');
  }
}

const app = router({
  lockedOut: publicProcedure.query(() => {
    throw new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      message: 'x',
      cause: new FakeAuthError('auth.too_many_attempts', { retryAfterSeconds: 842 }),
    });
  }),
  kycLockedOut: publicProcedure.query(() => {
    throw new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      message: 'x',
      cause: new FakeAuthError('kyc.attempts_exhausted', { retryAfterSeconds: 3599.2 }),
    });
  }),
  otherWithDetails: publicProcedure.query(() => {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'x',
      cause: new FakeAuthError('auth.invalid_credentials', { retryAfterSeconds: 5 }),
    });
  }),
  closedAccount: publicProcedure.query(() => {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'x', cause: new FakeAuthError('auth.account_frozen', { accountState: 'closed' }) });
  }),
  frozenNoState: publicProcedure.query(() => {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'x', cause: new FakeAuthError('auth.account_frozen') });
  }),
});

async function wireData(path: string): Promise<Record<string, unknown>> {
  const res = await fetchRequestHandler({
    endpoint: '/trpc',
    req: new Request(`http://localhost/trpc/${path}`),
    router: app,
    createContext: () => ({}) as Context,
  });
  return ((await res.json()) as { error: { data: Record<string, unknown> } }).error.data;
}

describe('errorFormatter retryAfterSeconds', () => {
  it('reaches the client for auth.too_many_attempts, alongside the code', async () => {
    const data = await wireData('lockedOut');
    expect(data.retryAfterSeconds).toBe(842);
    expect(data.cause).toEqual({ code: 'auth.too_many_attempts' });
    expect(data.httpStatus).toBe(429);
  });

  it('reaches the client for kyc.attempts_exhausted, rounded up to whole seconds', async () => {
    const data = await wireData('kycLockedOut');
    expect(data.retryAfterSeconds).toBe(3600);
    expect(data.cause).toEqual({ code: 'kyc.attempts_exhausted' });
  });

  it('is not added to any other error, even one that carries the same field', async () => {
    const data = await wireData('otherWithDetails');
    expect(data).not.toHaveProperty('retryAfterSeconds');
  });

  it('puts a non-empty request id on the error the client can show', async () => {
    const res = await fetchRequestHandler({
      endpoint: '/trpc',
      req: new Request('http://localhost/trpc/lockedOut'),
      router: app,
      createContext: () => ({ requestId: 'req-portal-1' }) as Context,
    });
    const data = ((await res.json()) as { error: { data: Record<string, unknown> } }).error.data;
    expect(data.requestId).toBe('req-portal-1');
  });

  it('omits requestId when the context has none', async () => {
    const data = await wireData('lockedOut');
    expect(data).not.toHaveProperty('requestId');
  });

  it('ignores junk values', () => {
    expect(retryAfterSecondsOf(new FakeAuthError('auth.too_many_attempts', { retryAfterSeconds: Number.NaN }))).toBeUndefined();
    expect(retryAfterSecondsOf(new FakeAuthError('auth.too_many_attempts', { retryAfterSeconds: -3 }))).toBeUndefined();
    expect(retryAfterSecondsOf(new FakeAuthError('auth.too_many_attempts'))).toBeUndefined();
    expect(retryAfterSecondsOf(undefined)).toBeUndefined();
    expect(retryAfterSecondsOf(new FakeAuthError('auth.too_many_attempts', { retryAfterSeconds: 1.2 }))).toBe(2);
    expect(retryAfterSecondsOf(new FakeAuthError('auth.email_confirm_rate_limited', { retryAfterSeconds: 90 }))).toBe(90);
    expect(retryAfterSecondsOf(new FakeAuthError('auth.invalid_credentials', { retryAfterSeconds: 90 }))).toBeUndefined();
  });

  it('returns the current profile only on a version conflict', async () => {
    const conflict = router({
      stale: publicProcedure.query(() => {
        const cause = new FakeAuthError('identity.profile_version_conflict');
        Object.assign(cause, { profile: { displayName: 'Ada', locale: 'en', region: 'DE', version: 2 } });
        throw new TRPCError({ code: 'CONFLICT', message: 'stale', cause });
      }),
    });
    const res = await fetchRequestHandler({
      endpoint: '/trpc',
      req: new Request('http://localhost/trpc/stale'),
      router: conflict,
      createContext: () => ({}) as Context,
    });
    const data = ((await res.json()) as { error: { data: Record<string, unknown> } }).error.data;
    expect(data.profile).toEqual({ displayName: 'Ada', locale: 'en', region: 'DE', version: 2 });
    expect(conflictProfile(undefined)).toBeUndefined();
  });
});

describe('errorFormatter accountState', () => {
  it('reaches the client on auth.account_frozen, alongside the code', async () => {
    const data = await wireData('closedAccount');
    expect(data.accountState).toBe('closed');
    expect(data.cause).toEqual({ code: 'auth.account_frozen' });
    expect(data.httpStatus).toBe(403);
  });

  it('is absent when the refusal carries none, and on every other error', async () => {
    expect(await wireData('frozenNoState')).not.toHaveProperty('accountState');
    expect(await wireData('lockedOut')).not.toHaveProperty('accountState');
  });

  it('keeps only the two known states on the one code', () => {
    expect(accountStateOf(new FakeAuthError('auth.account_frozen', { accountState: 'frozen' }))).toBe('frozen');
    expect(accountStateOf(new FakeAuthError('auth.account_frozen', { accountState: 'active' }))).toBeUndefined();
    expect(accountStateOf(new FakeAuthError('auth.account_frozen', { accountState: { x: 1 } }))).toBeUndefined();
    expect(accountStateOf(new FakeAuthError('auth.invalid_credentials', { accountState: 'closed' }))).toBeUndefined();
    expect(accountStateOf(undefined)).toBeUndefined();
  });
});

describe('errorFormatter algo creation amounts', () => {
  it('copies exact decimal strings for an insufficient-balance refusal and keeps the code', async () => {
    const cause = Object.assign(new Error('short'), {
      code: 'trade.algo_insufficient_balance',
      data: {
        asset: 'USDT',
        required: '60000000',
        available: '100',
        fee: '2',
        feeAsset: 'BTC',
        sliceQty: '1000',
        note: 'AlgoMarkPolicy.maxAgeSeconds is unset',
      },
    });
    const refused = router({
      short: publicProcedure.query(() => {
        throw new TRPCError({ code: 'BAD_REQUEST', message: cause.message, cause });
      }),
    });
    const res = await fetchRequestHandler({
      endpoint: '/trpc',
      req: new Request('http://localhost/trpc/short'),
      router: refused,
      createContext: () => ({}) as Context,
    });
    const data = ((await res.json()) as { error: { data: Record<string, unknown> } }).error.data;
    expect(data.cause).toEqual({ code: 'trade.algo_insufficient_balance' });
    expect(data.algo).toEqual({
      asset: 'USDT',
      required: '60000000',
      available: '100',
      fee: '2',
      feeAsset: 'BTC',
      sliceQty: '1000',
    });
    expect(JSON.stringify(data.algo)).not.toMatch(/AlgoMarkPolicy/);
  });

  it('drops amounts that are not decimal strings, and ignores other codes', () => {
    expect(
      algoRefusalDetails({ code: 'trade.algo_insufficient_balance', data: { asset: 'USDT', required: 'not-a-number' } }),
    ).toBeUndefined();
    expect(algoRefusalDetails({ code: 'trade.algo_price_band', data: { asset: 'USDT', required: '1' } })).toBeUndefined();
    expect(algoRefusalDetails(undefined)).toBeUndefined();
  });
});

describe('errorFormatter withdrawal allowance', () => {
  const exceeded = (remaining: unknown) =>
    Object.assign(new Error('pay.guard_withdrawal_limit_exceeded'), {
      code: 'pay.guard_withdrawal_limit_exceeded',
      kind: 'refused',
      remaining,
    });

  it('copies the allowance of a limit refusal onto the error data and keeps the code', async () => {
    const cause = exceeded({ perTx: '10', rolling24h: '5.5' });
    const refused = router({
      withdraw: publicProcedure.query(() => {
        throw new TRPCError({ code: 'FORBIDDEN', message: cause.message, cause });
      }),
    });
    const res = await fetchRequestHandler({
      endpoint: '/trpc',
      req: new Request('http://localhost/trpc/withdraw'),
      router: refused,
      createContext: () => ({}) as Context,
    });
    const data = ((await res.json()) as { error: { data: Record<string, unknown> } }).error.data;
    expect(data.cause).toEqual({ code: 'pay.guard_withdrawal_limit_exceeded' });
    expect(data.allowance).toEqual({ perTx: '10', rolling24h: '5.5' });
  });

  it('drops anything that is not a decimal string, extra keys, and every other code', () => {
    expect(withdrawalAllowanceOf(exceeded({ perTx: '10', rolling24h: 'lots' }))).toBeUndefined();
    expect(withdrawalAllowanceOf(exceeded({ perTx: 10, rolling24h: '5' }))).toBeUndefined();
    expect(withdrawalAllowanceOf(exceeded({ perTx: '10', rolling24h: '5', note: 'internal' }))).toEqual({ perTx: '10', rolling24h: '5' });
    expect(withdrawalAllowanceOf(exceeded(undefined))).toBeUndefined();
    expect(withdrawalAllowanceOf({ code: 'pay.guard_withdrawal_limit_unset', remaining: { perTx: '1', rolling24h: '1' } })).toBeUndefined();
    expect(withdrawalAllowanceOf(undefined)).toBeUndefined();
  });
});

describe('errorFormatter preview refusals', () => {
  it('surfaces kind, code, engine, action and label on data.preview', async () => {
    const refusal = previewRefusal('bank.loan_schedule', 'change_repayment_date');
    const refused = router({
      preview: publicProcedure.query(() => {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: refusal.label, cause: refusal });
      }),
    });
    const res = await fetchRequestHandler({
      endpoint: '/trpc',
      req: new Request('http://localhost/trpc/preview'),
      router: refused,
      createContext: () => ({}) as Context,
    });
    const data = ((await res.json()) as { error: { data: Record<string, unknown> } }).error.data;
    expect(data.cause).toEqual({ code: refusal.code });
    expect(data.preview).toEqual(refusal);
  });

  it('ignores anything that is not a full preview refusal', () => {
    expect(previewRefusalOf(undefined)).toBeUndefined();
    expect(previewRefusalOf({ code: 'preview.engine_not_built' })).toBeUndefined();
    expect(previewRefusalOf({ ...previewRefusal('bank.loan_schedule', 'repay'), kind: 'live' })).toBeUndefined();
    const extra = previewRefusalOf({ ...previewRefusal('bank.loan_schedule', 'repay'), secret: 'x' });
    expect(extra).toEqual(previewRefusal('bank.loan_schedule', 'repay'));
  });
});

describe('errorFormatter p2p take limits', () => {
  const refused = (code: string, limit: unknown) => Object.assign(new Error(code), { code, limit });
  const trade = '0b6f1c1e-4a7d-4c55-9d1e-2f6f0e8a1b2c';

  it('copies the order cap figures onto the error data and keeps the code', async () => {
    const cause = refused('p2p.active_order_cap', { until: '2026-10-23T18:04:05.123Z', cap: '2', openTradeIds: [trade] });
    const take = router({
      take: publicProcedure.query(() => {
        throw new TRPCError({ code: 'CONFLICT', message: cause.message, cause });
      }),
    });
    const res = await fetchRequestHandler({
      endpoint: '/trpc',
      req: new Request('http://localhost/trpc/take'),
      router: take,
      createContext: () => ({}) as Context,
    });
    const data = ((await res.json()) as { error: { data: Record<string, unknown> } }).error.data;
    expect(data.cause).toEqual({ code: 'p2p.active_order_cap' });
    expect(data.p2pLimit).toEqual({ until: '2026-10-23T18:04:05.123Z', cap: '2', openTradeIds: [trade] });
  });

  it('keeps a buying pause with its end, the cancels and the window', () => {
    expect(p2pLimitOf(refused('p2p.buying_restricted', { until: '2026-10-24T09:00:00.000Z', cap: '3', windowHours: '24' }))).toEqual({
      until: '2026-10-24T09:00:00.000Z',
      cap: '3',
      windowHours: '24',
    });
    expect(p2pLimitOf(refused('p2p.buying_restricted', { until: '2026-10-24T09:00:00.000Z', cap: '3', windowHours: 24 }))).toBeUndefined();
  });

  it('keeps a short balance with the seller’s free amount and the shortfall, and drops a malformed one', () => {
    expect(p2pLimitOf(refused('p2p.insufficient_balance', { until: null, available: '30', shortBy: '70' }))).toEqual({
      until: null,
      available: '30',
      shortBy: '70',
    });
    expect(p2pLimitOf(refused('p2p.insufficient_balance', { until: null, available: '30', shortBy: 'seventy' }))).toBeUndefined();
  });

  it('keeps the content rule class an ad broke, only on that refusal and only as a slug', () => {
    expect(p2pLimitOf(refused('p2p.content_rule_violation', { until: null, ruleClass: 'messenger' }))).toEqual({
      until: null,
      ruleClass: 'messenger',
    });
    expect(p2pLimitOf(refused('p2p.content_rule_violation', { until: null, ruleClass: 'message me on telegram' }))).toBeUndefined();
    expect(p2pLimitOf(refused('p2p.insufficient_balance', { until: null, ruleClass: 'messenger' }))).toBeUndefined();
  });

  it('keeps the field key of a payment destination refusal, only on those refusals and only as a key', () => {
    expect(p2pLimitOf(refused('p2p.account_format_invalid', { until: null, field: 'iban' }))).toEqual({ until: null, field: 'iban' });
    expect(p2pLimitOf(refused('p2p.instrument_field_missing', { until: null, field: 'account_holder' }))).toEqual({
      until: null,
      field: 'account_holder',
    });
    expect(p2pLimitOf(refused('p2p.account_format_invalid', { until: null, field: 'DE89 3704 0044' }))).toBeUndefined();
    expect(p2pLimitOf(refused('p2p.insufficient_balance', { until: null, field: 'iban' }))).toBeUndefined();
  });

  it('keeps a limit with no end time and its bounds', () => {
    expect(p2pLimitOf(refused('p2p.pair_limit_exceeded', { until: null, min: '10', max: '500', currency: 'EUR' }))).toEqual({
      until: null,
      min: '10',
      max: '500',
      currency: 'EUR',
    });
    expect(
      p2pLimitOf(refused('p2p.verification_daily_limit', { until: '2026-10-24T00:00:00Z', remaining: '0.5', currency: 'EUR' })),
    ).toEqual({
      until: '2026-10-24T00:00:00Z',
      remaining: '0.5',
      currency: 'EUR',
    });
  });

  it('drops a sentence, a malformed figure, a missing end time and every other code', () => {
    expect(p2pLimitOf(refused('p2p.pair_limit_exceeded', { until: 'tomorrow', min: '1' }))).toBeUndefined();
    expect(p2pLimitOf(refused('p2p.pair_limit_exceeded', { min: '1' }))).toBeUndefined();
    expect(p2pLimitOf(refused('p2p.pair_limit_exceeded', { until: null, max: 500 }))).toBeUndefined();
    expect(p2pLimitOf(refused('p2p.pair_limit_exceeded', { until: null, currency: 'euros' }))).toBeUndefined();
    expect(p2pLimitOf(refused('p2p.active_order_cap', { until: null, openTradeIds: ['not a trade'] }))).toBeUndefined();
    expect(p2pLimitOf(refused('p2p.active_order_cap', { until: null, cap: '2', note: 'internal' }))).toEqual({ until: null, cap: '2' });
    expect(p2pLimitOf(refused('p2p.quote_expired', { until: null }))).toBeUndefined();
    expect(p2pLimitOf(refused('p2p.method_delisted', { until: null, reason: 'regulation' }))).toEqual({
      until: null,
      reason: 'regulation',
    });
    expect(p2pLimitOf(refused('p2p.method_delisted', { until: null, reason: 'the bank said so' }))).toBeUndefined();
    expect(p2pLimitOf(refused('p2p.pair_limit_exceeded', { until: null, reason: 'regulation' }))).toBeUndefined();
    expect(p2pLimitOf(undefined)).toBeUndefined();
  });
});

describe('errorFormatter secondStep (I-signin-sessions-10)', () => {
  const passkey = {
    challenge: 'Y2hhbGxlbmdl',
    timeout: 60000,
    rpId: 'localhost',
    allowCredentials: [{ type: 'public-key', id: 'Y3JlZA', transports: ['internal'] }],
    userVerification: 'required',
  };
  const mfa = (secondStep: unknown) => new FakeAuthError('auth.mfa_required', { secondStep } as never);

  it('reaches the client on auth.mfa_required with the passkey challenge', async () => {
    const steps = router({
      both: publicProcedure.query(() => {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'x', cause: mfa({ totp: true, passkey }) });
      }),
    });
    const res = await fetchRequestHandler({
      endpoint: '/trpc',
      req: new Request('http://localhost/trpc/both'),
      router: steps,
      createContext: () => ({}) as Context,
    });
    const data = ((await res.json()) as { error: { data: Record<string, unknown> } }).error.data;
    expect(data.secondStep).toEqual({ totp: true, passkey });
  });

  it('drops any other code and any malformed passkey', () => {
    expect(secondStepOf(new FakeAuthError('auth.invalid_credentials', { secondStep: { totp: true, passkey } } as never))).toBeUndefined();
    expect(secondStepOf(mfa({ totp: true, passkey: null }))).toEqual({ totp: true, passkey: null });
    expect(secondStepOf(mfa({ totp: 'yes', passkey: null }))).toBeUndefined();
    expect(secondStepOf(mfa({ totp: false, passkey: { ...passkey, allowCredentials: [] } }))).toBeUndefined();
    expect(secondStepOf(mfa({ totp: false, passkey: { ...passkey, challenge: 'not base64url!' } }))).toBeUndefined();
    expect(
      secondStepOf(mfa({ totp: false, passkey: { ...passkey, allowCredentials: [{ type: 'other', id: 'Y3JlZA' }] } })),
    ).toBeUndefined();
    expect(secondStepOf(mfa({ totp: false, passkey: { ...passkey, userVerification: 'sometimes' } }))?.passkey).not.toHaveProperty(
      'userVerification',
    );
  });
});

describe('errorFormatter deviceAuthorisation recovery count (I-signin-sessions-12)', () => {
  const waiting = {
    flowId: '0b0e6f3c-8f6a-4c1d-9a7e-2f1b3c4d5e6f',
    secret: 's'.repeat(43),
    expiresAt: '2026-10-24T18:00:00.000Z',
    mailed: true,
  };
  const refusal = (deviceAuthorisation: unknown) =>
    new FakeAuthError('auth.device_authorisation_required', { deviceAuthorisation } as never);

  it('reaches the client with the waiting sign-in when its second step spent a recovery code', async () => {
    const app = router({
      spent: publicProcedure.query(() => {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'x', cause: refusal({ ...waiting, recoveryCodesLeft: 0 }) });
      }),
    });
    const res = await fetchRequestHandler({
      endpoint: '/trpc',
      req: new Request('http://localhost/trpc/spent'),
      router: app,
      createContext: () => ({}) as Context,
    });
    const data = ((await res.json()) as { error: { data: Record<string, unknown> } }).error.data;
    expect(data.deviceAuthorisation).toEqual({ ...waiting, recoveryCodesLeft: 0 });
  });

  it('carries no count when none was given, and drops one that is not a whole number of codes', () => {
    expect(deviceAuthorisationOf(refusal(waiting))).toEqual(waiting);
    expect(deviceAuthorisationOf(refusal({ ...waiting, recoveryCodesLeft: 4 }))).toEqual({ ...waiting, recoveryCodesLeft: 4 });
    for (const bad of [-1, 1.5, '3', null, Number.NaN]) {
      expect(deviceAuthorisationOf(refusal({ ...waiting, recoveryCodesLeft: bad }))).toEqual(waiting);
    }
  });
});
