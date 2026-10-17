import { describe, expect, it } from 'vitest';
import { SESSION_SCOPES } from '@intafaced/auth';
import { AuthService } from './auth-service.js';

const USER = '22222222-2222-4222-8222-222222222222';

function service(): AuthService {
  return new AuthService(
    (() => {
      throw new Error('sql must not run for a scope lookup');
    }) as never,
    {} as never,
    {} as never,
    {
      secret: 'owner-pay-scope-session-test-secret-long',
      issuer: 'intafaced',
      audience: 'intafaced.api',
      accessTtlSeconds: 900,
      refreshTtlSeconds: 3600,
    },
  );
}

describe('scopesForNewAccessToken', () => {
  it('stays on ordinary session scopes when no grant lookup is installed', async () => {
    const scopes = await service().scopesForNewAccessToken(USER);
    expect(scopes).toEqual([...SESSION_SCOPES]);
    expect(scopes).not.toContain('pay:read');
  });

  it('attaches only pay:read and pay:write from the published grant', async () => {
    const auth = service();
    auth.useOwnerPayScopeSource(async () => ['pay:refund', 'pay:read', 'pay:write', 'pay:payout', 'admin:write']);
    const scopes = await auth.scopesForNewAccessToken(USER);
    expect(scopes).toEqual([...SESSION_SCOPES, 'pay:read', 'pay:write']);
    expect(scopes).not.toContain('pay:refund');
    expect(scopes).not.toContain('pay:payout');
    expect(scopes).not.toContain('pay:onboard');
  });

  it('attaches pay:onboard when the grant returns it and still drops refund and payout', async () => {
    const auth = service();
    auth.useOwnerPayScopeSource(async () => ['pay:onboard', 'pay:refund', 'pay:payout']);
    const scopes = await auth.scopesForNewAccessToken(USER);
    expect(scopes).toEqual([...SESSION_SCOPES, 'pay:onboard']);
  });

  it('keeps the ordinary session when the grant lookup fails', async () => {
    const auth = service();
    auth.useOwnerPayScopeSource(async () => {
      throw new Error('pay down');
    });
    const scopes = await auth.scopesForNewAccessToken(USER);
    expect(scopes).toEqual([...SESSION_SCOPES]);
  });

  it('adds nothing when the owner is not granted', async () => {
    const auth = service();
    auth.useOwnerPayScopeSource(async () => []);
    expect(await auth.scopesForNewAccessToken(USER)).toEqual([...SESSION_SCOPES]);
  });
});
