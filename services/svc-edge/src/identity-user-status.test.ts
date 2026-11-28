import { describe, expect, it } from 'vitest';
import { serviceBodyDigest } from '@intafaced/contracts';
import { KeyUserStatusError } from './api-key-user-status.js';
import { assertIdentityUserActive, optionalAccountStatus, optionalAccountStatusFromExchange } from './identity-user-status.js';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '33333333-3333-4333-8333-333333333333';
const SECRET = 'edge-test-identity-ownership-secret-32';

function account(status: string, userId = USER) {
  return { userId, status, kycTier: 'none' as const };
}

describe('optionalAccountStatus', () => {
  it('reads identity status; never invents frozen or active', () => {
    expect(optionalAccountStatus({ status: 'active' })).toBe('active');
    expect(optionalAccountStatus({ status: 'frozen' })).toBe('frozen');
    expect(optionalAccountStatus({ status: 'closed' })).toBe('closed');
    expect(optionalAccountStatus({ userId: USER })).toBeUndefined();
    expect(optionalAccountStatus({ status: 'disabled' })).toBeUndefined();
    expect(optionalAccountStatus({ status: 'nope' })).toBeUndefined();
    expect(optionalAccountStatus(null)).toBeUndefined();
  });
});

describe('optionalAccountStatusFromExchange', () => {
  it('reads tRPC envelope or bare body', () => {
    expect(optionalAccountStatusFromExchange({ result: { data: { json: { status: 'frozen' } } } })).toBe('frozen');
    expect(optionalAccountStatusFromExchange({ result: { data: { status: 'closed' } } })).toBe('closed');
    expect(optionalAccountStatusFromExchange({ status: 'active' })).toBe('active');
    expect(optionalAccountStatusFromExchange({ accessToken: 'x' })).toBeUndefined();
  });
});

describe('assertIdentityUserActive', () => {
  it('active proceeds; frozen and closed cannot open a session', async () => {
    await expect(
      assertIdentityUserActive({
        identityUrl: 'http://identity.test',
        userId: USER,
        identityOwnershipSecret: SECRET,
        fetch: async () =>
          new Response(JSON.stringify(account('active')), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      }),
    ).resolves.toBeUndefined();

    await expect(
      assertIdentityUserActive({
        identityUrl: 'http://identity.test',
        userId: USER,
        identityOwnershipSecret: SECRET,
        fetch: async () =>
          new Response(JSON.stringify(account('frozen')), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      }),
    ).rejects.toMatchObject({ code: 'auth.account_frozen' });

    await expect(
      assertIdentityUserActive({
        identityUrl: 'http://identity.test',
        userId: USER,
        identityOwnershipSecret: SECRET,
        fetch: async () =>
          new Response(JSON.stringify(account('closed')), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      }),
    ).rejects.toBeInstanceOf(KeyUserStatusError);
  });

  it('GETs /internal/account/:userId with svc-edge ownership headers, never INTERNAL_SERVICE_SECRET', async () => {
    const seen: { url?: string; headers?: Headers } = {};
    await assertIdentityUserActive({
      identityUrl: 'http://identity.test/',
      userId: USER,
      identityOwnershipSecret: SECRET,
      fetch: async (input, init) => {
        seen.url = String(input);
        seen.headers = new Headers(init?.headers);
        return new Response(JSON.stringify(account('active')), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    expect(seen.url).toBe(`http://identity.test/internal/account/${USER}`);
    expect(seen.headers?.get('x-intafaced-service')).toBe('svc-edge');
    expect(seen.headers?.get('x-intafaced-service-sig')).toBeTruthy();
    expect(seen.headers?.get('x-intafaced-service-body')).toBe(serviceBodyDigest(''));
    expect(seen.headers?.get('authorization')).toBeNull();
    expect(seen.url).not.toMatch(/INTERNAL_SERVICE_SECRET|05_Web_Front/i);
  });

  it('404, 401, mismatch, missing status, and transport cannot open as live', async () => {
    const base = {
      identityUrl: 'http://identity.test',
      userId: USER,
      identityOwnershipSecret: SECRET,
    };
    await expect(assertIdentityUserActive({ ...base, fetch: async () => new Response(null, { status: 404 }) })).rejects.toMatchObject({
      code: 'auth.account_frozen',
    });
    await expect(assertIdentityUserActive({ ...base, fetch: async () => new Response(null, { status: 401 }) })).rejects.toMatchObject({
      code: 'auth.account_frozen',
    });
    await expect(assertIdentityUserActive({ ...base, fetch: async () => new Response(null, { status: 403 }) })).rejects.toMatchObject({
      code: 'auth.account_frozen',
    });
    await expect(
      assertIdentityUserActive({
        ...base,
        fetch: async () =>
          new Response(JSON.stringify(account('active', OTHER)), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      }),
    ).rejects.toMatchObject({ code: 'auth.account_frozen' });
    await expect(
      assertIdentityUserActive({
        ...base,
        fetch: async () =>
          new Response(JSON.stringify({ userId: USER }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      }),
    ).rejects.toMatchObject({ code: 'auth.account_frozen' });
    await expect(
      assertIdentityUserActive({
        ...base,
        fetch: async () => {
          throw new Error('ECONNREFUSED');
        },
      }),
    ).rejects.toMatchObject({ code: 'auth.account_frozen' });
  });
});
