import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createApiClient } from './api';
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
  it('sends caller headers but never lets them replace the bearer token', async () => {
    const seen: Array<Record<string, string>> = [];
    const api = createApiClient({
      token: () => 'real-token',
      fetch: async (_url, init) => {
        seen.push((init?.headers ?? {}) as Record<string, string>);
        return new Response(JSON.stringify({ result: { data: {} } }));
      },
    });
    await api.mutate('identity', 'auth.login', {}, z.unknown(), {
      headers: { 'X-Session-Transport': 'cookie', Authorization: 'Bearer attacker-chosen' },
    });
    expect(seen[0]).toMatchObject({ 'x-session-transport': 'cookie', authorization: 'Bearer real-token' });
  });
  it('talks to the cookie session doors with the CSRF marker and the browser-attached cookie, not a token', async () => {
    const seen: Array<{ url: string; credentials?: RequestCredentials; headers: Record<string, string> }> = [];
    const api = createApiClient({
      fetch: async (url, init) => {
        seen.push({ url: String(url), credentials: init?.credentials, headers: (init?.headers ?? {}) as Record<string, string> });
        return new Response(JSON.stringify({ result: { data: { ok: true } } }));
      },
    });
    expect(await api.session('logout', z.object({ ok: z.literal(true) }))).toEqual({ ok: true, data: { ok: true } });
    expect(seen[0]).toMatchObject({ url: '/api/identity/session/logout', credentials: 'same-origin' });
    expect(seen[0]!.headers['x-session-request']).toBe('1');
    expect(seen[0]!.headers.authorization).toBeUndefined();
  });
});
