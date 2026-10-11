import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { createFounderAuthority } from './authority.js';

const userId = randomUUID();
const principal: Principal = {
  userId,
  sub: userId,
  sid: randomUUID(),
  scopes: ['ops:read', 'ops:write'],
  mfa: true,
  tier: 'full',
  expiresAt: new Date(Date.now() + 60000),
};
const ctx: Context = { principal, service: null, region: 'ID', requestId: randomUUID() };
const options = { identityUrl: 'https://identity.invalid', serviceSecret: 's'.repeat(32), principalSecret: 'p'.repeat(32) };
const enabled = { status: 'enabled', userId, version: '1', changedAt: '2026-10-10T00:00:00Z' };
const response = (data: unknown) =>
  new Response(JSON.stringify({ result: { data } }), { status: 200, headers: { 'content-type': 'application/json' } });
describe('live founder CRM authority', () => {
  it('binds exact service body and forwards original signed principal', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(enabled));
    expect(await createFounderAuthority({ ...options, fetcher })(ctx)).toBe(userId);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://identity.invalid/trpc/accountControls.operatorEntitlement');
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    expect(init?.body).toBe(JSON.stringify({ userId }));
    expect(init?.headers).toMatchObject({
      'x-intafaced-service': 'svc-ops',
      'x-intafaced-principal': expect.any(String),
      'x-intafaced-principal-sig': expect.any(String),
      'x-intafaced-region': 'ID',
    });
  });
  it('refuses unavailable, disabled, malformed and mismatched live authority', async () => {
    for (const data of [
      { status: 'revoked', userId, version: '1', changedAt: enabled.changedAt },
      { status: 'unconfigured', userId },
      { ...enabled, userId: randomUUID() },
      { status: 'enabled' },
    ]) {
      await expect(
        createFounderAuthority({ ...options, fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(data)) })(ctx),
      ).rejects.toHaveProperty('code');
    }
    await expect(
      createFounderAuthority({ ...options, fetcher: vi.fn<typeof fetch>().mockRejectedValue(new Error('network')) })(ctx),
    ).rejects.toMatchObject({ code: 'ops.crm.authority_unavailable' });
    await expect(createFounderAuthority({})(ctx)).rejects.toMatchObject({ code: 'ops.crm.authority_unconfigured' });
    await expect(
      createFounderAuthority({ ...options, fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 403 })) })(ctx),
    ).rejects.toMatchObject({ code: 'ops.crm.operator_forbidden' });
  });
  it('rejects API keys, subaccounts, stale tokens and missing MFA before calling identity', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const p of [
      null,
      { ...principal, kid: 'key' },
      { ...principal, sub_account: randomUUID() },
      { ...principal, mfa: false },
      { ...principal, expiresAt: new Date(0) },
    ]) {
      await expect(createFounderAuthority({ ...options, fetcher })({ ...ctx, principal: p })).rejects.toMatchObject({
        code: 'ops.crm.operator_forbidden',
      });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});
