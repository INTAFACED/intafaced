import { describe, expect, it } from 'vitest';
import { verifyAccessToken } from '@intafaced/auth';
import { apiKeyOriginAllowed } from './api-key-origin.js';
import { AuthService } from './auth-service.js';

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEY_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const tokens = {
  secret: 'api-key-origin-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 3600,
};

/**
 * A service over a `sql` tag that answers by statement: the account is active, nothing is frozen, and the presented
 * key is a live row stored with `mode`. Each statement's text (values as `$?`) and values are recorded.
 */
function keyService(row: { mode?: string | null }) {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const fn = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('$?').replace(/\s+/g, ' ').trim();
    queries.push({ text, values });
    if (text.startsWith('SELECT status FROM users')) return [{ status: 'active' }];
    if (text.startsWith('INSERT INTO api_keys')) return [{ id: KEY_ID }];
    if (text.startsWith('SELECT id, user_id, scopes, expires_at, mode, domain_whitelist, account_id FROM api_keys'))
      return [
        {
          id: KEY_ID,
          user_id: USER,
          scopes: ['trade:read'],
          expires_at: null,
          mode: row.mode ?? null,
          domain_whitelist: [],
          account_id: null,
        },
      ];
    return [];
  };
  const sql = fn as never;
  return { auth: new AuthService(sql, {} as never, {} as never, tokens), queries, executor: sql };
}

describe('apiKeyOriginAllowed', () => {
  it('allows any origin when the whitelist is empty (server bots)', () => {
    expect(apiKeyOriginAllowed([], undefined)).toBe(true);
    expect(apiKeyOriginAllowed([], 'https://evil.example')).toBe(true);
  });

  it('refuses missing origin when the whitelist is set', () => {
    expect(apiKeyOriginAllowed(['app.example.com'], undefined)).toBe(false);
    expect(apiKeyOriginAllowed(['app.example.com'], null)).toBe(false);
    expect(apiKeyOriginAllowed(['app.example.com'], '')).toBe(false);
  });

  it('matches hostnames and full origins; rejects foreign hosts', () => {
    const list = ['app.example.com', 'https://partner.example'];
    expect(apiKeyOriginAllowed(list, 'https://app.example.com')).toBe(true);
    expect(apiKeyOriginAllowed(list, 'https://app.example.com/dashboard')).toBe(true);
    expect(apiKeyOriginAllowed(list, 'https://partner.example')).toBe(true);
    expect(apiKeyOriginAllowed(list, 'https://evil.example')).toBe(false);
    expect(apiKeyOriginAllowed(list, 'https://not-app.example.com')).toBe(false);
  });

  it('allows a subdomain of a listed registrable host', () => {
    expect(apiKeyOriginAllowed(['example.com'], 'https://app.example.com')).toBe(true);
    expect(apiKeyOriginAllowed(['example.com'], 'https://example.com')).toBe(true);
  });
});

describe('API key mode of record — default live, never sandbox unless minted', () => {
  it('createApiKey defaults omitted mode to live and prefixes via generateApiKey(mode)', async () => {
    const cases = [
      { mode: undefined, scopes: ['trade:read'], stored: 'live', head: /^ifc_(?!test_)/ },
      { mode: 'live' as const, scopes: ['trade:read'], stored: 'live', head: /^ifc_(?!test_)/ },
      { mode: 'sandbox' as const, scopes: ['pay:read'], stored: 'sandbox', head: /^ifc_test_/ },
    ];
    for (const c of cases) {
      const { auth, queries, executor } = keyService({});
      const made = await auth.createApiKey({
        userId: USER,
        name: 'bot',
        scopes: c.scopes,
        grantorScopes: c.scopes,
        ...(c.mode ? { mode: c.mode } : {}),
        executor,
      });
      expect(made.mode).toBe(c.stored);
      // The key carries the mode's prefix, and the row stored is that mode with the key's own prefix.
      expect(made.key).toMatch(c.head);
      expect(made.prefix).toBe(made.key.slice(0, 12));
      const insert = queries.find((q) => q.text.startsWith('INSERT INTO api_keys'));
      expect(insert?.values.slice(3)).toEqual([made.prefix, c.scopes, [], null, c.stored]);
    }
  });

  it('exchangeApiKey mints keyEnv from verified.mode — default live cannot become sandbox', async () => {
    for (const [stored, keyEnv] of [
      ['live', 'live'],
      ['something-else', 'live'],
      ['sandbox', 'sandbox'],
    ] as const) {
      const { auth } = keyService({ mode: stored });
      const out = await auth.exchangeApiKey('ifc_presented-key', null);
      const principal = await verifyAccessToken(out.accessToken, tokens);
      expect(out.mode, String(stored)).toBe(keyEnv);
      expect(principal.key_env, String(stored)).toBe(keyEnv);
    }
  });
});
