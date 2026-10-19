/**
 * Unit card — apiKeys.list limit unset refuse (no invented 50, no dump)
 *
 * 1. Promise: omitted API-key list limit does not dump keys or become a default page.
 * 2. Break: listApiKeys(userId) with no LIMIT dressed a blank page as every key.
 * 3. Done bar: no listApiKeys(userId) without limit; no input?.limit / ?? / .default;
 *    unset/null/out of 1..200 throw identity.api_keys_list_limit_unset before SQL.
 * 4. Class N
 * 5. Paths: router.ts apiKeys.list; auth-service.ts listApiKeys
 * 6. RED: omitting limit returns every api_keys row for the user
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  API_KEYS_LIST_LIMIT_MAX,
  ApiKeysListLimitUnsetError,
  AuthService,
  IDENTITY_API_KEYS_LIST_LIMIT_UNSET,
  publishedApiKeysListLimit,
} from './auth-service.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function serviceWithUnreachableSql(): { auth: AuthService; sqlCalled: () => boolean } {
  let sqlCalled = false;
  const sql = Object.assign(() => {
    sqlCalled = true;
    throw new Error('sql must not run when API keys list limit is unset');
  }, {}) as never;
  const auth = new AuthService(sql, {} as never, {} as never, {
    secret: 'api-keys-list-limit-test-secret-long-enough',
    issuer: 'intafaced',
    audience: 'intafaced.api',
    accessTtlSeconds: 900,
    refreshTtlSeconds: 3600,
  });
  return { auth, sqlCalled: () => sqlCalled };
}

describe('apiKeys.list / listApiKeys limit unset refuse (no invented 50)', () => {
  it('router.ts requires limit 1..200 and passes input.limit', () => {
    const src = readFileSync(join(HERE, '../router.ts'), 'utf8');
    expect(src).not.toMatch(/listApiKeys\(ctx\.principal\.userId\)\s*;/);
    expect(src).toMatch(/listApiKeys\(ctx\.principal\.userId, input\.limit\)/);
    expect(src).not.toMatch(/omit never dumps API keys[\s\S]{0,250}limit: z\.number\(\)\.int\(\)\.min\(1\)\.max\(200\)\.optional\(\)/);
    expect(src).not.toMatch(/omit never dumps API keys[\s\S]{0,250}limit: z\.number\(\)\.int\(\)\.min\(1\)\.max\(200\)\.default\(/);
    expect(src).toMatch(/omit never dumps API keys[\s\S]{0,250}limit: z\.number\(\)\.int\(\)\.min\(1\)\.max\(200\)/);
    expect(src).not.toMatch(/listApiKeys\([^)]*\?\? 50/);
  });

  it('auth-service.ts does not invent a page via default param', () => {
    const src = readFileSync(join(HERE, 'auth-service.ts'), 'utf8');
    expect(src).not.toMatch(/async listApiKeys\([^)]*limit = /);
    expect(src).toMatch(/publishedApiKeysListLimit\(limit\)/);
    expect(src).toMatch(/FROM api_keys WHERE user_id = \$\{userId\} ORDER BY created_at DESC LIMIT \$\{published\}/);
  });

  it('list selects signing posture and the IP allowlist, never the secret or the key hash', () => {
    const src = readFileSync(join(HERE, 'auth-service.ts'), 'utf8');
    const listFn = src.slice(src.indexOf('async listApiKeys'), src.indexOf('async kycTier'));
    expect(listFn).toMatch(/require_signature, require_non_empty_ip_allowlist, ip_allowlist/);
    expect(listFn).not.toMatch(/request_signing_secret/);
    expect(listFn).not.toMatch(/key_hash/);
    const router = readFileSync(join(HERE, '../router.ts'), 'utf8');
    expect(router).toMatch(/requireSignature: k\.require_signature === true/);
    expect(router).toMatch(/ipAllowlist: k\.ip_allowlist \?\? \[\]/);
    expect(router).not.toMatch(/signingSecret: k\./);
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
