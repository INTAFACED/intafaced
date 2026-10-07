import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createApiClient } from './api';

describe('customer transport boundary', () => {
  it('refuses a monetary JSON number instead of rendering a successful balance', async () => {
    const api = createApiClient({ fetch: async () => new Response(JSON.stringify({ result: { data: { available: 0.1 } } })) });
    const result = await api.query('bank', 'overview', {}, z.object({ available: z.string() }));
    expect(result).toMatchObject({ ok: false, reason: 'invalid_response' });
  });
});
