import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createApiClient, setScopedBearer } from './api';
import { savePreferences } from './preferences';

describe('customer transport boundary', () => {
  it('refuses a monetary JSON number instead of rendering a successful balance', async () => {
    const api = createApiClient({ fetch: async () => new Response(JSON.stringify({ result: { data: { available: 0.1 } } })) });
    const result = await api.query('bank', 'overview', {}, z.object({ available: z.string() }));
    expect(result).toMatchObject({ ok: false, reason: 'invalid_response' });
  });
  it('preserves the service explanation when a REST refusal carries a string error', async () => {
    const api = createApiClient({
      fetch: async () =>
        new Response(JSON.stringify({ error: 'Forbidden', message: 'Verification tier full is required.' }), { status: 403 }),
    });
    const result = await api.rest('/account/balance', z.unknown());
    expect(result).toMatchObject({ ok: false, message: 'Verification tier full is required.' });
  });
  it('sends no JSON content type on a body-less DELETE, so the trade service accepts a cancel', async () => {
    const seen: Array<{ method?: string; headers: Record<string, string>; body?: unknown }> = [];
    const api = createApiClient({
      fetch: async (_url, init) => {
        seen.push({ method: init?.method, headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body });
        return new Response(JSON.stringify({ id: 'o1' }));
      },
    });
    await api.rest('/orders/o1', z.unknown(), { method: 'DELETE' });
    await api.rest('/orders', z.unknown(), { method: 'POST', body: { symbol: 'BTC/USDT' } });
    expect(seen[0]).toMatchObject({ method: 'DELETE', body: undefined });
    expect(seen[0]!.headers['content-type']).toBeUndefined();
    expect(seen[1]!.headers['content-type']).toBe('application/json');
  });
  it('reports an unreadable gateway failure as a connection problem', async () => {
    const api = createApiClient({ fetch: async () => new Response('', { status: 503 }) });
    expect(await api.rest('/markets', z.unknown())).toMatchObject({ ok: false, reason: 'unreachable' });
  });
  it('preserves the domain cause code from the production tRPC formatter', async () => {
    const api = createApiClient({
      fetch: async () =>
        new Response(
          JSON.stringify({
            error: {
              message: 'NOTIFY_VERIFY_TTL_MINUTES is unset. Blank refuses.',
              data: { code: 'PRECONDITION_FAILED', cause: { code: 'notify.verify_ttl_unset' } },
            },
          }),
          { status: 412 },
        ),
    });
    expect(await api.mutate('notify', 'notify.registerTarget', {}, z.unknown())).toMatchObject({
      ok: false,
      status: 412,
      code: 'notify.verify_ttl_unset',
      message: 'NOTIFY_VERIFY_TTL_MINUTES is unset. Blank refuses.',
    });
  });
  it('keeps explicit authentication codes ahead of generic or nested cause codes', async () => {
    const api = createApiClient({
      fetch: async () =>
        new Response(
          JSON.stringify({
            error: {
              message: 'Original explanation',
              data: { intafacedCode: 'denied.kyc_required', code: 'FORBIDDEN', cause: { code: 'other.domain' } },
            },
          }),
          { status: 403 },
        ),
    });
    expect(await api.query('bank', 'read', {}, z.unknown())).toMatchObject({ ok: false, code: 'denied.kyc_required' });
  });
  it('reads the specific reason from a market route refusal instead of its broad class', async () => {
    // Observed from the public ticker of a listed market that has no live book: the class sits in `code`, the reason beside it.
    const api = createApiClient({
      fetch: async () =>
        new Response(
          JSON.stringify({ code: 'ExchangeError', message: 'matching holds no book for a market', intafacedCode: 'trade.no_book' }),
          { status: 404 },
        ),
    });
    expect(await api.rest('/ticker/ETH%2FUSDT', z.unknown())).toMatchObject({ ok: false, status: 404, code: 'trade.no_book' });
  });
  it('still falls back to the broad class when a market route sends no specific reason', async () => {
    const api = createApiClient({
      fetch: async () => new Response(JSON.stringify({ code: 'ExchangeError', message: 'x' }), { status: 400 }),
    });
    expect(await api.rest('/ticker/ETH%2FUSDT', z.unknown())).toMatchObject({ ok: false, code: 'ExchangeError' });
  });
  it('refuses to dispatch a write after its account context has changed', async () => {
    const sent: string[] = [];
    const api = createApiClient({
      canWrite: () => false,
      fetch: async (url) => {
        sent.push(String(url));
        return new Response(JSON.stringify({ id: 'order-reference' }));
      },
    });
    const result = await api.rest('/orders', z.object({ id: z.string() }), { method: 'POST', body: {} });
    expect(result).toMatchObject({ ok: false, reason: 'aborted' });
    expect(sent).toHaveLength(0);
  });
  it('keeps a dispatched write uncertain when its caller aborts the wait', async () => {
    const controller = new AbortController();
    const api = createApiClient({
      fetch: async () => {
        controller.abort();
        throw new DOMException('Wait stopped', 'AbortError');
      },
    });
    const result = await api.rest('/orders', z.unknown(), { method: 'POST', body: {}, signal: controller.signal });
    expect(result).toMatchObject({ ok: false, reason: 'uncertain' });
  });
  it('localizes authored transport explanations while preserving the service explanation and exact payload', async () => {
    savePreferences({ language: 'es' });
    try {
      const bodies: string[] = [];
      const offline = createApiClient({
        fetch: async (_url, options) => {
          bodies.push(String(options?.body));
          return new Response('', { status: 503 });
        },
      });
      const result = await offline.rest('/orders', z.unknown(), { method: 'POST', body: { quantity: '0.000000000000000001' } });
      expect(result).toMatchObject({
        ok: false,
        reason: 'uncertain',
        message: 'La pasarela no confirmó el resultado. Comprueba la solicitud original antes de volver a intentarlo.',
      });
      expect(bodies).toEqual(['{"quantity":"0.000000000000000001"}']);
      const refused = createApiClient({
        fetch: async () => new Response(JSON.stringify({ message: 'Opaque service explanation', code: 'order.original' }), { status: 403 }),
      });
      expect(await refused.rest('/orders', z.unknown())).toMatchObject({
        ok: false,
        message: 'Opaque service explanation',
        code: 'order.original',
      });
    } finally {
      savePreferences({ language: 'en' });
    }
  });
});

describe('a call with its own bearer', () => {
  const unauthorized = () => new Response(JSON.stringify({ error: { message: 'no', data: { code: 'UNAUTHORIZED' } } }), { status: 401 });
  it('sends that token for that call only and leaves the session token for every other call', async () => {
    const seen: Array<string | undefined> = [];
    const api = createApiClient({
      token: () => 'session-token',
      fetch: async (_url, init) => {
        seen.push((init?.headers as Record<string, string>).authorization);
        return new Response(JSON.stringify({ result: { data: {} } }));
      },
    });
    await api.mutate('pay', 'payment.refund', {}, z.unknown(), { bearer: 'confirm-token' });
    await api.mutate('pay', 'payment.refund', {}, z.unknown());
    await api.query('pay', 'payment.get', {}, z.unknown());
    expect(seen).toEqual(['Bearer confirm-token', 'Bearer session-token', 'Bearer session-token']);
  });
  it('does not end the session when its own token is refused', async () => {
    const ended: Array<string | undefined> = [];
    const api = createApiClient({ token: () => 'session-token', onUnauthorized: (t) => ended.push(t), fetch: async () => unauthorized() });
    expect(await api.mutate('pay', 'settlement.payout', {}, z.unknown(), { bearer: 'confirm-token' })).toMatchObject({
      ok: false,
      reason: 'unauthorized',
    });
    expect(ended).toEqual([]);
    await api.mutate('pay', 'settlement.payout', {}, z.unknown());
    expect(ended).toEqual(['session-token']);
  });
  it('keeps the session only for the codes a call names as its own answer (a wrong code); any other 401 ends it', async () => {
    const ended: Array<string | undefined> = [];
    const withCode = (code?: string) =>
      new Response(JSON.stringify({ error: { message: 'no', data: { code: 'UNAUTHORIZED', ...(code ? { cause: { code } } : {}) } } }), {
        status: 401,
      });
    let next = withCode('auth.mfa_invalid');
    const api = createApiClient({ token: () => 'session-token', onUnauthorized: (t) => ended.push(t), fetch: async () => next.clone() });
    const own = { keepSessionFor: ['auth.mfa_invalid', 'auth.webauthn_invalid'] };
    await api.mutate('identity', 'auth.stepUpPay', {}, z.unknown(), own);
    expect(ended).toEqual([]);
    // the session really ended: a 401 with another code, or none, signs out as usual
    next = withCode('auth.session_invalid');
    await api.mutate('identity', 'auth.stepUpPay', {}, z.unknown(), own);
    next = withCode();
    await api.mutate('identity', 'auth.stepUpPay', {}, z.unknown(), own);
    expect(ended).toEqual(['session-token', 'session-token']);
  });
  it('keeps the session on 503 edge.authority_unavailable and only a 401 clears it', async () => {
    const ended: Array<string | undefined> = [];
    const api = createApiClient({
      token: () => 'session-token',
      onUnauthorized: (t) => ended.push(t),
      fetch: async () =>
        new Response(JSON.stringify({ error: 'Something went wrong. Try again.', code: 'edge.authority_unavailable' }), {
          status: 503,
          headers: { 'retry-after': '1' },
        }),
    });
    expect(await api.query('pay', 'notifications.list', {}, z.unknown())).toMatchObject({
      ok: false,
      status: 503,
      code: 'edge.authority_unavailable',
    });
    expect(ended).toEqual([]);
  });
  it('asks the registered resolver for a mutation, by procedure, and for nothing else', async () => {
    const seen: Array<string | undefined> = [];
    const api = createApiClient({
      token: () => 'session-token',
      fetch: async (_url, init) => {
        seen.push((init?.headers as Record<string, string>).authorization);
        return new Response(JSON.stringify({ result: { data: {} } }));
      },
    });
    setScopedBearer((module, procedure) => (module === 'pay' && procedure === 'payment.refund' ? 'confirm-token' : undefined));
    try {
      await api.mutate('pay', 'payment.refund', {}, z.unknown());
      await api.mutate('pay', 'payment.capture', {}, z.unknown());
      await api.mutate('identity', 'payment.refund', {}, z.unknown());
      await api.query('pay', 'payment.refund', {}, z.unknown());
    } finally {
      setScopedBearer(null);
    }
    expect(seen).toEqual(['Bearer confirm-token', 'Bearer session-token', 'Bearer session-token', 'Bearer session-token']);
  });
});
