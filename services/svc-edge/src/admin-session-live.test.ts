import { describe, expect, it } from 'vitest';
import { AuthError, issueAccessToken, type TokenConfig } from '@intafaced/auth';
import { KillSwitchState } from './kill-switch.js';
import { createAdminApi } from './admin-api.js';
import { stubApprovalConsumer } from './action-approval-consume.js';

const tokens: TokenConfig = {
  secret: 'test-only-signing-secret-at-least-32-characters-long',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

describe('operator authenticate requires a live session when wired', () => {
  it('rejects a signed token whose session the checker refuses', async () => {
    const admin = createAdminApi(new KillSwitchState(), {
      tokens,
      ledger: null,
      approvals: stubApprovalConsumer('44444444-4444-4444-8444-444444444444'),
      sessionLive: async () => {
        throw new AuthError('Operator session is not live', 'token.invalid');
      },
    });
    const { token } = await issueAccessToken(
      {
        userId: '11111111-1111-4111-8111-111111111111',
        sessionId: '22222222-2222-4222-8222-222222222222',
        scopes: ['admin:write'],
        tier: 'institutional',
        mfa: true,
      },
      tokens,
    );
    await expect(admin.authenticate(`Bearer ${token}`)).rejects.toMatchObject({ code: 'token.invalid' });
  });

  it('rejects a founder lookup token whose session the checker refuses, and accepts it while live', async () => {
    let live = false;
    const admin = createAdminApi(new KillSwitchState(), {
      tokens,
      ledger: null,
      approvals: stubApprovalConsumer('44444444-4444-4444-8444-444444444444'),
      sessionLive: async () => {
        if (!live) throw new AuthError('Operator session is not live', 'token.invalid');
      },
    });
    const { token } = await issueAccessToken(
      {
        userId: '11111111-1111-4111-8111-111111111111',
        sessionId: '22222222-2222-4222-8222-222222222222',
        scopes: ['admin:read'],
        tier: 'institutional',
        mfa: true,
      },
      tokens,
    );
    await expect(admin.authenticateLookup(`Bearer ${token}`)).rejects.toMatchObject({ code: 'token.invalid' });
    live = true;
    await expect(admin.authenticateLookup(`Bearer ${token}`)).resolves.toMatchObject({ userId: '11111111-1111-4111-8111-111111111111' });
  });
  it('refuses a control-list token whose session is not live as a dead session, not as a missing scope', async () => {
    let live = false;
    const admin = createAdminApi(new KillSwitchState(), {
      tokens,
      ledger: null,
      approvals: stubApprovalConsumer('44444444-4444-4444-8444-444444444444'),
      sessionLive: async () => {
        if (!live) throw new AuthError('Operator session is not live', 'token.invalid');
      },
    });
    const { token } = await issueAccessToken(
      {
        userId: '11111111-1111-4111-8111-111111111111',
        sessionId: '22222222-2222-4222-8222-222222222222',
        scopes: ['admin:compliance'],
        tier: 'institutional',
        mfa: true,
      },
      tokens,
    );
    await expect(admin.authenticateControlRead(`Bearer ${token}`)).rejects.toMatchObject({ code: 'token.invalid' });
    live = true;
    await expect(admin.authenticateControlRead(`Bearer ${token}`)).resolves.toMatchObject({
      userId: '11111111-1111-4111-8111-111111111111',
    });
  });
});
