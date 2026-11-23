import { describe, expect, it } from 'vitest';
import { TRPCError, type Context } from '@intafaced/contracts';
import { QuantError } from '../errors.js';
import {
  claimKeyIdempotency,
  createMemoryKeyIdempotencyRepository,
  idempotencyKeyHeaderOf,
  QUANT_KEY_API,
  refuseKeyCall,
  type QuantContext,
} from './key-api.js';

// J-algo-dev-14: the strategy API, what an API key may call on svc-quant and under which scope.

type Principal = NonNullable<Context['principal']>;
const ACCOUNT = '00000000-0000-4000-8000-000000000001';
const person: Principal = {
  userId: ACCOUNT,
  sub: ACCOUNT,
  sid: '00000000-0000-4000-8000-000000000003',
  scopes: ['trade:read'],
  tier: 'basic',
  mfa: false,
  expiresAt: new Date('2026-11-16T01:00:00Z'),
};
const keyWith = (...scopes: string[]) => ({ ...person, kid: '00000000-0000-4000-8000-000000000009', scopes }) as Principal;

function refusal(fn: () => void): { code: string; cause: string | undefined } {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(TRPCError);
    const e = err as TRPCError;
    return { code: e.code, cause: (e.cause as { code?: string } | undefined)?.code };
  }
  throw new Error('expected a refusal');
}

describe('refuseKeyCall', () => {
  it('lets a session, a service and a signed-out caller through untouched', () => {
    expect(() => refuseKeyCall(person, ['live.deploy', 'studio.save'])).not.toThrow();
    expect(() => refuseKeyCall(null, ['live.deploy'])).not.toThrow();
  });

  it('answers a key NOT_FOUND quant.key_no_such_endpoint outside the strategy API, deploy included', () => {
    const all = keyWith('quant:read', 'quant:run', 'trade:read', 'trade:write');
    for (const path of ['live.deploy', 'live.check', 'studio.save', 'library.publish', 'nope.nothing'])
      expect(refusal(() => refuseKeyCall(all, [path]))).toEqual({ code: 'NOT_FOUND', cause: 'quant.key_no_such_endpoint' });
  });

  it('a read key lists and reads, and is refused scope.denied on start', () => {
    const read = keyWith('quant:read');
    expect(() =>
      refuseKeyCall(read, ['studio.list', 'studio.get', 'backtest.result', 'backtest.report', 'backtest.history']),
    ).not.toThrow();
    expect(refusal(() => refuseKeyCall(read, ['backtest.start']))).toEqual({ code: 'FORBIDDEN', cause: 'scope.denied' });
  });

  it('quant:run does not imply quant:read', () => {
    const run = keyWith('quant:run');
    expect(() => refuseKeyCall(run, ['backtest.start'])).not.toThrow();
    expect(refusal(() => refuseKeyCall(run, ['studio.list']))).toEqual({ code: 'FORBIDDEN', cause: 'scope.denied' });
  });

  it('a batch is refused whole when one call in it is', () => {
    expect(refusal(() => refuseKeyCall(keyWith('quant:read'), ['studio.list', 'backtest.start']))).toEqual({
      code: 'FORBIDDEN',
      cause: 'scope.denied',
    });
  });

  it('names exactly the strategy API', () => {
    expect(QUANT_KEY_API).toEqual({
      'studio.list': 'quant:read',
      'studio.get': 'quant:read',
      'backtest.history': 'quant:read',
      'backtest.result': 'quant:read',
      'backtest.report': 'quant:read',
      'backtest.start': 'quant:run',
    });
  });
});

describe('claimKeyIdempotency', () => {
  const at = new Date('2026-11-16T00:00:00Z');
  const ctx = (header: string | null, principal: Principal = keyWith('quant:run')) =>
    ({ principal, idempotencyKeyHeader: header }) as QuantContext;
  const code = async (p: Promise<void>) =>
    p.then(
      () => 'ok',
      (err: unknown) => (err instanceof QuantError ? err.code : String(err)),
    );

  it('a session needs no header', async () => {
    const store = createMemoryKeyIdempotencyRepository();
    expect(await code(claimKeyIdempotency(ctx(null, person), ACCOUNT, 'backtest.start', { a: 1 }, store, at))).toBe('ok');
  });

  it('a key must send one, of a valid shape', async () => {
    const store = createMemoryKeyIdempotencyRepository();
    expect(await code(claimKeyIdempotency(ctx(null), ACCOUNT, 'backtest.start', {}, store, at))).toBe('quant.idempotency_key_required');
    expect(await code(claimKeyIdempotency(ctx(''), ACCOUNT, 'backtest.start', {}, store, at))).toBe('quant.idempotency_key_required');
    expect(await code(claimKeyIdempotency(ctx('has space'), ACCOUNT, 'backtest.start', {}, store, at))).toBe(
      'quant.idempotency_key_invalid',
    );
    expect(await code(claimKeyIdempotency(ctx('x'.repeat(129)), ACCOUNT, 'backtest.start', {}, store, at))).toBe(
      'quant.idempotency_key_invalid',
    );
  });

  it('the same key and request goes on twice; the same key with another request is refused', async () => {
    const store = createMemoryKeyIdempotencyRepository();
    const input = { strategyId: 's', strategyVersion: 1, costs: { feeRole: 'taker', slippageBps: '5' } };
    expect(await code(claimKeyIdempotency(ctx('bt:1'), ACCOUNT, 'backtest.start', input, store, at))).toBe('ok');
    // The same request with its fields in another order is the same request.
    const reordered = { costs: { slippageBps: '5', feeRole: 'taker' }, strategyVersion: 1, strategyId: 's' };
    expect(await code(claimKeyIdempotency(ctx('bt:1'), ACCOUNT, 'backtest.start', reordered, store, at))).toBe('ok');
    expect(await code(claimKeyIdempotency(ctx('bt:1'), ACCOUNT, 'backtest.start', { ...input, strategyVersion: 2 }, store, at))).toBe(
      'quant.idempotency_key_reused',
    );
    // Another account's same key is its own.
    expect(
      await code(claimKeyIdempotency(ctx('bt:1'), '00000000-0000-4000-8000-000000000002', 'backtest.start', { other: true }, store, at)),
    ).toBe('ok');
  });

  it('reads the header as one string', () => {
    expect(idempotencyKeyHeaderOf({ 'idempotency-key': 'k' })).toBe('k');
    expect(idempotencyKeyHeaderOf({ 'idempotency-key': ['a', 'b'] })).toBe('a');
    expect(idempotencyKeyHeaderOf({})).toBeNull();
  });
});
