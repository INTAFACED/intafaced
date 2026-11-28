/**
 * Unit card — apiKeys.list limit unset refuse (no invented 50, no dump)
 *
 * 1. Promise: omitted API-key list limit does not dump keys or become a default page.
 * 2. Break: listApiKeys(userId) with no LIMIT dressed a blank page as every key.
 * 3. Done bar: apiKeys.list hands the caller's limit through; a missing or out-of-range limit refuses at the door;
 *    the query carries that exact LIMIT; unset/null/out of 1..200 throw identity.api_keys_list_limit_unset before SQL.
 * 4. Class N
 * 5. Paths: router.ts apiKeys.list; auth-service.ts listApiKeys
 * 6. RED: omitting limit returns every api_keys row for the user
 */
import { describe, expect, it } from 'vitest';
import { partial } from '@intafaced/service-kit/testing';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { IDENTITY_API_KEYS_LIST } from '@intafaced/contracts/identity-api-keys-procedures';
import { createIdentityRouter } from '../router.js';
import type { RankService } from '../rank/rank-service.js';
import {
  API_KEYS_LIST_LIMIT_MAX,
  ApiKeysListLimitUnsetError,
  AuthService,
  IDENTITY_API_KEYS_LIST_LIMIT_UNSET,
  publishedApiKeysListLimit,
} from './auth-service.js';

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const authConfig = {
  secret: 'api-keys-list-limit-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 3600,
};

function serviceWithUnreachableSql(): { auth: AuthService; sqlCalled: () => boolean } {
  let sqlCalled = false;
  const sql = Object.assign(() => {
    sqlCalled = true;
    throw new Error('sql must not run when API keys list limit is unset');
  }, {}) as never;
  const auth = new AuthService(sql, {} as never, {} as never, authConfig);
  return { auth, sqlCalled: () => sqlCalled };
}

/** A service over a `sql` tag that records each query's text (values as `$?`) and its values. */
function serviceOverSql(rows: unknown[]): { auth: AuthService; queries: Array<{ text: string; values: unknown[] }> } {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    queries.push({ text: strings.join('$?').replace(/\s+/g, ' ').trim(), values });
    return Promise.resolve(rows);
  };
  return { auth: new AuthService(sql as never, {} as never, {} as never, authConfig), queries };
}

/** The identity router over a stub service that records each call it gets. */
function routerOver(methods: Partial<Record<keyof AuthService, (...args: never[]) => Promise<unknown>>>) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const auth: Record<string, unknown> = {};
  for (const [method, run] of Object.entries(methods))
    auth[method] = (...args: never[]) => {
      calls.push({ method, args });
      return run(...args);
    };
  const router = createIdentityRouter(partial<AuthService>(auth), partial<RankService>({}), { registrationOpen: true });
  return { router, calls };
}

async function signedIn(scopes: string[]): Promise<Context> {
  const { token } = await issueAccessToken({ userId: USER, sessionId: SESSION, scopes, tier: 'none', mfa: true }, authConfig);
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-1' };
}

describe('apiKeys.list / listApiKeys limit unset refuse (no invented 50)', () => {
  it("apiKeys.list hands the caller's own limit to listApiKeys and refuses a missing or out-of-range one", async () => {
    const { router, calls } = routerOver({ listApiKeys: async () => [] });
    const api = router.createCaller(await signedIn(['identity:read']));
    await expect(api.apiKeys.list({ limit: 7 })).resolves.toEqual([]);
    expect(calls).toEqual([{ method: 'listApiKeys', args: [USER, 7] }]);
    for (const bad of [{}, { limit: undefined }, { limit: null }, { limit: 0 }, { limit: 201 }, { limit: 1.5 }]) {
      const err = await api.apiKeys.list(bad as never).catch((e: unknown) => e);
      expect((err as { code?: string }).code, JSON.stringify(bad)).toBe('BAD_REQUEST');
    }
    expect(calls).toHaveLength(1);
    // The input is the call's record (mounted here), so its limit is checked as the record parses it: required, 1..200.
    const input = IDENTITY_API_KEYS_LIST.input;
    for (const bad of [{}, { limit: undefined }, { limit: null }, { limit: 0 }, { limit: 201 }, { limit: 1.5 }])
      expect(input.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    expect(input.parse({ limit: 1 })).toEqual({ limit: 1 });
    expect(input.parse({ limit: 200 })).toEqual({ limit: 200 });
  });

  it("listApiKeys asks for exactly the published page of this user's keys, newest first", async () => {
    const { auth, queries } = serviceOverSql([]);
    await expect(auth.listApiKeys(USER, 7)).resolves.toEqual([]);
    expect(queries).toHaveLength(1);
    expect(queries[0]?.text).toMatch(/FROM api_keys WHERE user_id = \$\? ORDER BY created_at DESC LIMIT \$\?$/);
    expect(queries[0]?.values).toEqual([USER, 7]);
  });

  it('list selects signing posture and the IP allowlist, never the secret or the key hash', async () => {
    const { auth, queries } = serviceOverSql([]);
    await auth.listApiKeys(USER, 1);
    const text = queries[0]?.text ?? '';
    expect(text).toMatch(/require_signature, require_non_empty_ip_allowlist, ip_allowlist/);
    expect(text).not.toMatch(/request_signing_secret/);
    expect(text).not.toMatch(/key_hash/);
    // The router maps each row: signing posture as a boolean, a null allowlist as empty, and no secret goes out.
    const row = {
      id: 'key-1',
      name: 'bot',
      key_prefix: 'ifc_abc',
      scopes: ['trade:read'],
      last_used_at: null,
      revoked: false,
      mode: 'live',
      require_signature: true,
      require_non_empty_ip_allowlist: null,
      ip_allowlist: null,
      request_signing_secret: 'must-not-leave',
      key_hash: 'must-not-leave',
    };
    const { router } = routerOver({ listApiKeys: async () => [row] });
    const api = router.createCaller(await signedIn(['identity:read']));
    const [out] = await api.apiKeys.list({ limit: 1 });
    expect(out).toMatchObject({ requireSignature: true, requireNonEmptyIpAllowlist: false, ipAllowlist: [] });
    expect(out).not.toHaveProperty('signingSecret');
    expect(JSON.stringify(out)).not.toContain('must-not-leave');
  });

  it('blank / non-integer / out of 1..200 throws identity.api_keys_list_limit_unset', () => {
    for (const limit of [undefined, null, 0, -1, 201, 1.5, Number.NaN]) {
      try {
        publishedApiKeysListLimit(limit);
        expect.unreachable(`expected throw for limit=${String(limit)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(ApiKeysListLimitUnsetError);
        expect((err as ApiKeysListLimitUnsetError).code).toBe(IDENTITY_API_KEYS_LIST_LIMIT_UNSET);
      }
    }
  });

  it('owner-explicit 1 and max are published windows', () => {
    expect(publishedApiKeysListLimit(1)).toBe(1);
    expect(publishedApiKeysListLimit(API_KEYS_LIST_LIMIT_MAX)).toBe(200);
  });

  it('omitted / undefined / null limit refuses before SQL', async () => {
    for (const limit of [undefined, null] as unknown as number[]) {
      const { auth, sqlCalled } = serviceWithUnreachableSql();
      await expect(auth.listApiKeys(USER, limit)).rejects.toMatchObject({
        name: 'ApiKeysListLimitUnsetError',
        code: IDENTITY_API_KEYS_LIST_LIMIT_UNSET,
      });
      expect(sqlCalled()).toBe(false);
    }
  });
});
