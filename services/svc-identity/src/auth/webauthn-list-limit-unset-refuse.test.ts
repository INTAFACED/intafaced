/**
 * Unit card — webauthn.list / listWebauthnCredentials limit unset refuse (no invented 50, no dump)
 *
 * 1. Promise: omitted WebAuthn list limit does not dump credentials or become a default page.
 * 2. Break: listWebauthnCredentials(userId) with no page size dressed a blank page as every credential.
 * 3. Done bar: webauthn.list refuses a missing or out-of-range limit at the door and hands a given one through;
 *    the answer holds no more than that many, newest first;
 *    unset/null/out of 1..200 throw identity.webauthn_list_limit_unset before SQL.
 * 4. Class N
 * 5. Paths: router.ts webauthn.list; auth-service.ts listWebauthnCredentials
 * 6. RED: omitting limit returns every webauthn_creds entry for the user
 */
import { describe, expect, it } from 'vitest';
import { partial } from '@intafaced/service-kit/testing';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { createIdentityRouter } from '../router.js';
import type { RankService } from '../rank/rank-service.js';
import {
  AuthService,
  IDENTITY_WEBAUTHN_LIST_LIMIT_UNSET,
  WEBAUTHN_LIST_LIMIT_MAX,
  WebauthnListLimitUnsetError,
  publishedWebauthnListLimit,
} from './auth-service.js';

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const authConfig = {
  secret: 'webauthn-list-limit-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 3600,
};

function serviceWithUnreachableSql(): { auth: AuthService; sqlCalled: () => boolean } {
  let sqlCalled = false;
  const sql = Object.assign(() => {
    sqlCalled = true;
    throw new Error('sql must not run when WebAuthn list limit is unset');
  }, {}) as never;
  const auth = new AuthService(sql, {} as never, {} as never, authConfig);
  return { auth, sqlCalled: () => sqlCalled };
}

/** A service whose users row holds `n` passkeys, enrolled one a day. */
function serviceWithPasskeys(n: number): AuthService {
  const creds = Array.from({ length: n }, (_, i) => ({
    credentialId: `cred-${i}`,
    publicKey: 'pk',
    counter: 0,
    createdAt: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
  }));
  const sql = async () => [{ webauthn_creds: creds }];
  return new AuthService(sql as never, {} as never, {} as never, authConfig);
}

async function signedIn(): Promise<Context> {
  const { token } = await issueAccessToken(
    { userId: USER, sessionId: SESSION, scopes: ['identity:read'], tier: 'none', mfa: true },
    authConfig,
  );
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-1' };
}

describe('webauthn.list / listWebauthnCredentials limit unset refuse (no invented 50)', () => {
  it('webauthn.list requires limit 1..200 and passes input.limit', async () => {
    const calls: unknown[][] = [];
    const auth = partial<AuthService>({
      listWebauthnCredentials: async (...args: unknown[]) => {
        calls.push(args);
        return [];
      },
    });
    const api = createIdentityRouter(auth, partial<RankService>({}), { registrationOpen: true, webauthnEnabled: true }).createCaller(
      await signedIn(),
    );
    await expect(api.webauthn.list({ limit: 7 })).resolves.toEqual([]);
    expect(calls).toEqual([[USER, 7]]);
    for (const bad of [{}, { limit: undefined }, { limit: null }, { limit: 0 }, { limit: 201 }, { limit: 1.5 }]) {
      const err = await api.webauthn.list(bad as never).catch((e: unknown) => e);
      expect((err as { code?: string }).code, JSON.stringify(bad)).toBe('BAD_REQUEST');
    }
    expect(calls).toHaveLength(1);
  });

  it('listWebauthnCredentials returns at most the published limit, newest first', async () => {
    const auth = serviceWithPasskeys(5);
    expect((await auth.listWebauthnCredentials(USER, 2)).map((c) => c.credentialId)).toEqual(['cred-4', 'cred-3']);
    expect(await auth.listWebauthnCredentials(USER, 1)).toHaveLength(1);
    expect(await auth.listWebauthnCredentials(USER, WEBAUTHN_LIST_LIMIT_MAX)).toHaveLength(5);
  });

  it('blank / non-integer / out of 1..200 throws identity.webauthn_list_limit_unset', () => {
    for (const limit of [undefined, null, 0, -1, 201, 1.5, Number.NaN]) {
      try {
        publishedWebauthnListLimit(limit);
        expect.unreachable(`expected throw for limit=${String(limit)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(WebauthnListLimitUnsetError);
        expect((err as WebauthnListLimitUnsetError).code).toBe(IDENTITY_WEBAUTHN_LIST_LIMIT_UNSET);
      }
    }
  });

  it('owner-explicit 1 and max are published windows', () => {
    expect(publishedWebauthnListLimit(1)).toBe(1);
    expect(publishedWebauthnListLimit(WEBAUTHN_LIST_LIMIT_MAX)).toBe(200);
  });

  it('omitted / undefined / null limit refuses before SQL', async () => {
    for (const limit of [undefined, null] as unknown as number[]) {
      const { auth, sqlCalled } = serviceWithUnreachableSql();
      await expect(auth.listWebauthnCredentials(USER, limit)).rejects.toMatchObject({
        name: 'WebauthnListLimitUnsetError',
        code: IDENTITY_WEBAUTHN_LIST_LIMIT_UNSET,
      });
      expect(sqlCalled()).toBe(false);
    }
  });
});
