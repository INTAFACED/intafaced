import { describe, expect, it, vi } from 'vitest';
import { fetchOwnerPayScopes } from './owner-pay-scopes.js';

const USER = '22222222-2222-4222-8222-222222222222';

describe('fetchOwnerPayScopes', () => {
  it('returns the scope list pay already granted', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ merchantId: 'm', scopes: ['pay:read', 'pay:write'] }), { status: 200 }),
    );
    await expect(
      fetchOwnerPayScopes({ payUrl: 'http://127.0.0.1:4010', secret: 's'.repeat(32), userId: USER, fetchImpl }),
    ).resolves.toEqual(['pay:read', 'pay:write']);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('throws when pay refuses, so the caller can omit pay scopes', async () => {
    const fetchImpl = vi.fn(async () => new Response('no', { status: 401 }));
    await expect(
      fetchOwnerPayScopes({ payUrl: 'http://127.0.0.1:4010/', secret: 's'.repeat(32), userId: USER, fetchImpl }),
    ).rejects.toThrow(/HTTP 401/);
  });
});
