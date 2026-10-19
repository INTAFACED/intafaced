import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { SESSION_SCOPES, type Principal } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { createFounderAuthority } from './founder-authority.js';

const userId = randomUUID();
const principal: Principal = {
  userId,
  sub: userId,
  sid: randomUUID(),
  scopes: [...SESSION_SCOPES],
  mfa: true,
  tier: 'full',
  expiresAt: new Date(Date.now() + 60000),
};
// The exact edge-signed bytes this request arrived with. Pay holds no key that could produce them.
const forwardedPrincipal = { raw: JSON.stringify({ userId }), signature: `ed25519:${'A'.repeat(86)}`, region: 'ID' };
const ctx: Context = { principal, service: null, region: 'ID', requestId: randomUUID(), forwardedPrincipal };
const options = { identityUrl: 'https://identity.invalid', serviceSecret: 's'.repeat(32) };
const enabled = { status: 'enabled', userId, version: '1', changedAt: '2026-10-10T00:00:00Z' };
const response = (data: unknown) =>
  new Response(JSON.stringify({ result: { data } }), { status: 200, headers: { 'content-type': 'application/json' } });
describe('live founder merchant authority', () => {
  it('binds exact service body and forwards original signed principal', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(enabled));
    expect(await createFounderAuthority({ ...options, fetcher })(ctx)).toBe(userId);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://identity.invalid/trpc/accountControls.operatorEntitlement');
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    expect(init?.body).toBe(JSON.stringify({ userId }));
    expect(init?.headers).toMatchObject({
      'x-intafaced-service': 'svc-pay',
      'x-intafaced-principal': forwardedPrincipal.raw,
      'x-intafaced-principal-sig': forwardedPrincipal.signature,
      'x-intafaced-region': 'ID',
    });
  });
  it('refuses when the request carries no edge-signed principal to pass on, instead of signing one itself', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(enabled));
    const { forwardedPrincipal: _dropped, ...unsigned } = ctx;
    await expect(createFounderAuthority({ ...options, fetcher })(unsigned)).rejects.toMatchObject({ code: 'authority.unavailable' });
    expect(fetcher).not.toHaveBeenCalled();
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
    ).rejects.toMatchObject({ code: 'authority.unavailable' });
    await expect(createFounderAuthority({})(ctx)).rejects.toMatchObject({ code: 'authority.unavailable' });
    await expect(
      createFounderAuthority({ ...options, fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 403 })) })(ctx),
    ).rejects.toMatchObject({ code: 'operator.denied' });
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
        code: 'operator.denied',
      });
    }
    expect(fetcher).not.toHaveBeenCalled();
    await expect(createFounderAuthority({ ...options, fetcher })({ ...ctx, service: 'svc-admin' })).rejects.toMatchObject({
      code: 'operator.denied',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
