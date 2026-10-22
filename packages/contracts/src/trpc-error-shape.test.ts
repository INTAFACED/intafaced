import { describe, expect, it } from 'vitest';
import { TRPCError } from '@trpc/server';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { previewRefusal } from './preview-refusal.js';
import {
  algoRefusalDetails,
  previewRefusalOf,
  withdrawalAllowanceOf,
  publicProcedure,
  retryAfterSecondsOf,
  conflictProfile,
  router,
  type Context,
} from './trpc.js';

/** Stand-in with the same shape as svc-identity's AuthError (a different class from @intafaced/auth's). */
class FakeAuthError extends Error {
  constructor(
    readonly code: string,
    readonly details?: { retryAfterSeconds?: number },
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
  otherWithDetails: publicProcedure.query(() => {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'x',
      cause: new FakeAuthError('auth.invalid_credentials', { retryAfterSeconds: 5 }),
    });
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
