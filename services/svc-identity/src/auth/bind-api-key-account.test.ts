import { describe, expect, it } from 'vitest';
import { AuthError, type AuthService } from './auth-service.js';
import { apiKeyAccountAllowed } from './api-key-account.js';
import {
  assertApiKeyAccount,
  assertPortfolioKeyRoom,
  bindApiKeyAccount,
  installApiKeyAccountExchange,
  requestAccountAls,
} from './bind-api-key-account.js';

function fakeSql(queue: unknown[][]) {
  let i = 0;
  const fn = async () => {
    const rows = queue[i] ?? [];
    i += 1;
    return rows;
  };
  return fn as unknown as Parameters<typeof bindApiKeyAccount>[0];
}

const USER = 'u';
const KEY = 'k';
const ACC = 'acc-a';
const OTHER = 'acc-b';

describe('bindApiKeyAccount', () => {
  it('refuses a missing accountId and does not write', async () => {
    const sql = fakeSql([[{ id: ACC, parent_user_id: USER, revoked: false }]]);
    await expect(bindApiKeyAccount(sql, USER, KEY, undefined)).rejects.toMatchObject({
      code: 'auth.account_required',
    });
    await expect(bindApiKeyAccount(sql, USER, KEY, '')).rejects.toMatchObject({
      code: 'auth.account_required',
    });
  });

  it('refuses a foreign or revoked account', async () => {
    await expect(
      bindApiKeyAccount(fakeSql([[{ id: OTHER, parent_user_id: 'stranger', revoked: false }]]), USER, KEY, OTHER),
    ).rejects.toMatchObject({ code: 'auth.account_denied' });
    await expect(bindApiKeyAccount(fakeSql([[]]), USER, KEY, ACC)).rejects.toMatchObject({
      code: 'auth.account_denied',
    });
    await expect(bindApiKeyAccount(fakeSql([[{ id: ACC, parent_user_id: USER, revoked: true }]]), USER, KEY, ACC)).rejects.toMatchObject({
      code: 'auth.account_revoked',
    });
  });

  it('returns the bound account and treats a missing key as not found', async () => {
    const ok = fakeSql([[{ id: ACC, parent_user_id: USER, revoked: false }], [{ id: KEY, account_id: ACC }]]);
    await expect(bindApiKeyAccount(ok, USER, KEY, ` ${ACC} `)).resolves.toEqual({
      id: KEY,
      accountId: ACC,
    });
    await expect(
      bindApiKeyAccount(fakeSql([[{ id: ACC, parent_user_id: USER, revoked: false }], []]), USER, KEY, ACC),
    ).rejects.toMatchObject({ code: 'auth.not_found' });
  });
});

describe('assertPortfolioKeyRoom (the bind door keeps the sub-account key cap)', () => {
  it('blank refuses, full refuses, room passes, and the key being bound is not counted', async () => {
    await expect(assertPortfolioKeyRoom(fakeSql([]), USER, ACC, null, KEY)).rejects.toMatchObject({
      code: 'identity.portfolio_key_cap_unset',
    });
    await expect(assertPortfolioKeyRoom(fakeSql([[{ n: 2 }]]), USER, ACC, 2, KEY)).rejects.toMatchObject({
      code: 'identity.portfolio_key_cap_reached',
    });
    await expect(assertPortfolioKeyRoom(fakeSql([[{ n: 1 }]]), USER, ACC, 2, KEY)).resolves.toBeUndefined();
    const seen: unknown[][] = [];
    const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      seen.push(values);
      return [{ n: 0 }];
    }) as unknown as Parameters<typeof bindApiKeyAccount>[0];
    await assertPortfolioKeyRoom(sql, USER, ACC, 2, KEY);
    expect(seen[0]).toEqual([USER, ACC, KEY]);
  });
});

describe('assertApiKeyAccount', () => {
  it('refuses empty, mismatch, and unbound; match works', async () => {
    await expect(assertApiKeyAccount(fakeSql([[]]), USER, KEY, '')).rejects.toMatchObject({
      code: 'auth.account_required',
    });
    await expect(assertApiKeyAccount(fakeSql([[{ id: KEY, account_id: ACC, revoked: false }]]), USER, KEY, OTHER)).rejects.toMatchObject({
      code: 'auth.account_mismatch',
    });
    await expect(assertApiKeyAccount(fakeSql([[{ id: KEY, account_id: null, revoked: false }]]), USER, KEY, ACC)).rejects.toMatchObject({
      code: 'auth.account_mismatch',
    });
    await expect(assertApiKeyAccount(fakeSql([[{ id: KEY, account_id: ACC, revoked: false }]]), USER, KEY, ACC)).resolves.toEqual({
      id: KEY,
      accountId: ACC,
    });
    expect(apiKeyAccountAllowed(ACC, OTHER)).toBe(false);
  });
});

describe('installApiKeyAccountExchange', () => {
  it('bound key: missing or other account refuses; match exchanges; unbound stays open', async () => {
    const exchanged: string[] = [];
    const auth = {
      async exchangeApiKey(key: string) {
        exchanged.push(key);
        return { accessToken: 't', expiresAt: new Date(), userId: USER, keyId: KEY, scopes: [], mode: 'live' as const };
      },
    };
    const boundSql = fakeSql(Array.from({ length: 4 }, () => [{ account_id: ACC }]));
    installApiKeyAccountExchange(auth as unknown as AuthService, boundSql);

    await expect(auth.exchangeApiKey('secret')).rejects.toBeInstanceOf(AuthError);
    await expect(auth.exchangeApiKey('secret')).rejects.toMatchObject({ code: 'auth.invalid_credentials' });
    await expect(requestAccountAls.run(OTHER, () => auth.exchangeApiKey('secret'))).rejects.toMatchObject({
      code: 'auth.invalid_credentials',
    });
    await expect(requestAccountAls.run(ACC, () => auth.exchangeApiKey('secret'))).resolves.toMatchObject({
      accessToken: 't',
    });
    expect(exchanged).toEqual(['secret']);

    const open = {
      async exchangeApiKey(key: string) {
        return { accessToken: key, expiresAt: new Date(), userId: USER, keyId: KEY, scopes: [], mode: 'live' as const };
      },
    };
    installApiKeyAccountExchange(open as unknown as AuthService, fakeSql([[{ account_id: null }]]));
    await expect(open.exchangeApiKey('legacy')).resolves.toMatchObject({ accessToken: 'legacy' });
  });
});
