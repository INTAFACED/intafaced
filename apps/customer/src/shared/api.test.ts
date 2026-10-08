import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createApiClient } from './api';

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
  it('reports an unreadable gateway failure as a connection problem', async () => {
    const api = createApiClient({ fetch: async () => new Response('', { status: 503 }) });
    expect(await api.rest('/markets', z.unknown())).toMatchObject({ ok: false, reason: 'unreachable' });
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
});
