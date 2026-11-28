/**
 * Unit card — createSubAccount refuse when cap unpublished
 *
 * 1. Promise: omitted / invalid cap → auth.sub_account_cap_unset (no invented 25).
 *    Owner-explicit 25 is a published number, not a git default.
 * 2. Break: constructor DEFAULT_MAX_SUB_ACCOUNTS = 25 lets blank look published.
 * 3. Done bar: mock-sql create refuses before INSERT; source has no DEFAULT 25.
 * 4. Class M
 * 5. Paths: auth-service.ts createSubAccount
 * 6. RED: unset create succeeds or source git-defaults 25
 */
import { describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import type { Sql } from 'postgres';
import type { RankService } from '../rank/rank-service.js';
import { AuthService } from './auth-service.js';

const USER = '11111111-1111-4111-8111-111111111111';
const tokenConfig = {
  secret: 'an-identity-test-signing-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
};

function activeUserSql(): Sql {
  const fn = async () => [{ status: 'active' }];
  return Object.assign(fn, { json: (v: unknown) => v }) as unknown as Sql;
}

/** An active account holding `live` sub-accounts; each statement's text is recorded and a create returns a new id. */
function sqlWithLive(live: number): { sql: Sql; statements: string[] } {
  const statements: string[] = [];
  const fn = async (strings: TemplateStringsArray) => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim();
    statements.push(text);
    if (text.startsWith('SELECT count(*)::text AS n FROM sub_accounts')) return [{ n: String(live) }];
    if (text.startsWith('INSERT INTO sub_accounts')) return [{ id: '22222222-2222-4222-8222-222222222222' }];
    if (text.includes('FROM users')) return [{ id: USER, status: 'active' }];
    return [];
  };
  const sql = Object.assign(fn, {
    json: (v: unknown) => v,
    begin: (_isolation: string, cb: (tx: unknown) => unknown) => cb(fn),
  }) as Sql;
  return { sql, statements };
}

function makeAuthOver(sql: Sql, maxSubAccounts?: number) {
  return new AuthService(
    sql,
    new MemoryEventBus('svc-identity'),
    {} as RankService,
    tokenConfig,
    undefined,
    undefined,
    undefined,
    undefined,
    maxSubAccounts,
  );
}

function makeAuth(maxSubAccounts?: number) {
  return new AuthService(
    activeUserSql(),
    new MemoryEventBus('svc-identity'),
    {} as RankService,
    tokenConfig,
    undefined,
    undefined,
    undefined,
    undefined,
    maxSubAccounts,
  );
}

describe('createSubAccount cap unpublished', () => {
  it('auth-service.ts does not git-default 25', async () => {
    // Built with no cap, a create is refused by name before any sub-account is counted or written, even with none live.
    const unset = sqlWithLive(0);
    await expect(makeAuthOver(unset.sql).createSubAccount(USER, 'bot')).rejects.toMatchObject({ code: 'auth.sub_account_cap_unset' });
    expect(unset.statements.filter((s) => s.includes('sub_accounts'))).toEqual([]);
    // 25 is a number the owner publishes, nothing more: the published cap is the one enforced, whatever it is.
    for (const [cap, live, outcome] of [
      [25, 24, 'created'],
      [25, 25, 'auth.sub_account_limit'],
      [26, 25, 'created'],
      [3, 3, 'auth.sub_account_limit'],
      [3, 2, 'created'],
    ] as const) {
      const run = sqlWithLive(live);
      const out = await makeAuthOver(run.sql, cap)
        .createSubAccount(USER, 'bot')
        .then(() => 'created')
        .catch((err: { code?: string }) => err.code);
      expect(out, `cap ${cap}, ${live} live`).toBe(outcome);
      expect(run.statements.some((s) => s.startsWith('INSERT INTO sub_accounts'))).toBe(outcome === 'created');
    }
  });

  it('unset cap refuses create (does not invent 25)', async () => {
    await expect(makeAuth().createSubAccount(USER, 'bot')).rejects.toMatchObject({
      code: 'auth.sub_account_cap_unset',
    });
  });

  it('NaN / 0 cap refuses create (does not invent 25)', async () => {
    await expect(makeAuth(Number.NaN).createSubAccount(USER, 'bot')).rejects.toMatchObject({
      code: 'auth.sub_account_cap_unset',
    });
    await expect(makeAuth(0).createSubAccount(USER, 'bot')).rejects.toMatchObject({
      code: 'auth.sub_account_cap_unset',
    });
  });
});
